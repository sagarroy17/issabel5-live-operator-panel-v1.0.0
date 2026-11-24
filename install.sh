#!/bin/bash
set -e

echo "============================================================"
echo "  Issabel 5 Live Operator Panel (FOP2 Style) - Installer"
echo "============================================================"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Install Node.js 20 LTS if not already installed
if ! command -v node &> /dev/null; then
    echo "[1/6] Installing Node.js 20 LTS..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
else
    echo "[1/6] Node.js is already installed ($(node -v))."
fi

# 2. Auto-detect MySQL root password and Asterisk AMI credentials
echo "[2/6] Detecting Issabel MySQL & AMI credentials..."
MYSQL_PASS=$(grep -E "^mysqlrootpwd=" /etc/issabel.conf 2>/dev/null | cut -d'=' -f2 | tr -d ' \r\n')
[ -z "$MYSQL_PASS" ] && MYSQL_PASS="admin"

AMI_USER="admin"
AMI_PASS=$(awk '/^\[admin\]/{f=1;next} /^\[/{f=0} f && /^secret/{print $3; exit}' /etc/asterisk/manager.conf | tr -d ' \r\n')
[ -z "$AMI_PASS" ] && AMI_PASS="admin"

# 3. Deploy backend & frontend files
echo "[3/6] Deploying backend & frontend files..."
mkdir -p /opt/custom-operator-panel/public
cp "$SCRIPT_DIR/app/server.js" /opt/custom-operator-panel/
cp "$SCRIPT_DIR/app/package.json" /opt/custom-operator-panel/
cp "$SCRIPT_DIR/app/public/index.html" /opt/custom-operator-panel/public/

sed -i "s/password: '.*'/password: '$MYSQL_PASS'/g" /opt/custom-operator-panel/server.js
sed -i "s/new AsteriskManager(5038, '127.0.0.1', '.*', '.*', true)/new AsteriskManager(5038, '127.0.0.1', '$AMI_USER', '$AMI_PASS', true)/g" /opt/custom-operator-panel/server.js

cd /opt/custom-operator-panel
npm install --production --silent

# 4. Configure and start systemd service
echo "[4/6] Configuring systemd service (operator-panel)..."
cat << 'SERVICE' > /etc/systemd/system/operator-panel.service
[Unit]
Description=Issabel 5 Live Operator Panel Service
After=network.target asterisk.service mariadb.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/custom-operator-panel
ExecStart=/usr/bin/node /opt/custom-operator-panel/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable operator-panel
systemctl restart operator-panel

# 5. Register Issabel PBX Menu Module & SQLite ACL
echo "[5/6] Registering Issabel Web GUI menu item..."
mkdir -p /var/www/html/modules/operator_panel_live
cp -r "$SCRIPT_DIR/issabel-module/"* /var/www/html/modules/operator_panel_live/
chown -R asterisk:asterisk /var/www/html/modules/operator_panel_live

sqlite3 /var/www/db/menu.db "INSERT OR IGNORE INTO menu (id, IdParent, Link, Name, Type, order_no) VALUES ('operator_panel_live', 'pbxconfig', '', 'Live Operator Panel', 'module', 99);"
sqlite3 /var/www/db/acl.db "INSERT OR IGNORE INTO acl_resource (id, name, description) VALUES (9991, 'operator_panel_live', 'Live Operator Panel');"
sqlite3 /var/www/db/acl.db "INSERT OR IGNORE INTO acl_group_permission (id_action, id_group, id_resource) VALUES (1, 1, 9991);"

# 6. Configure Apache Reverse Proxy
echo "[6/6] Configuring Apache Reverse Proxy..."
sed -i '/op-panel/d' /etc/httpd/conf.d/ssl.conf
sed -i '/<\/VirtualHost>/i RewriteEngine On\nRewriteCond %{HTTP:Upgrade} =websocket [NC]\nRewriteRule ^/op-panel/socket.io/(.*) ws://127.0.0.1:3050/socket.io/$1 [P,L]\nProxyPass /op-panel/ http://127.0.0.1:3050/\nProxyPassReverse /op-panel/ http://127.0.0.1:3050/' /etc/httpd/conf.d/ssl.conf

httpd -t && systemctl restart httpd

echo "============================================================"
echo "  Installation Complete!"
echo "  Open Issabel Web GUI -> PBX -> Live Operator Panel"
echo "============================================================"
