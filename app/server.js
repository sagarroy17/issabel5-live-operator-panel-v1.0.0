const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const AsteriskManager = require('asterisk-manager');
const mysql = require('mysql2/promise');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    path: '/socket.io'
});

app.use(express.static('public'));

const dbConfig = {
    host: '127.0.0.1',
    user: 'root',
    password: 'admin',
    database: 'asterisk'
};

// 1. Fetch extensions list from MySQL
app.get('/api/extensions', async (req, res) => {
    try {
        const conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.execute('SELECT extension, name FROM users ORDER BY CAST(extension AS UNSIGNED), extension ASC');
        await conn.end();
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Fetch trunks list from MySQL and Asterisk SIP peers
app.get('/api/trunks', async (req, res) => {
    try {
        const conn = await mysql.createConnection(dbConfig);
        const [dbTrunks] = await conn.execute('SELECT trunkid, name, tech, channelid, disabled FROM trunks WHERE disabled = "off" ORDER BY trunkid ASC');
        const [users] = await conn.execute('SELECT extension FROM users');
        await conn.end();

        const extSet = new Set(users.map(u => String(u.extension)));
        const trunkMap = new Map();

        dbTrunks.forEach(t => {
            const key = (t.channelid || t.name || '').trim();
            if (key) {
                trunkMap.set(key, {
                    key,
                    name: t.name || key,
                    tech: (t.tech || 'SIP').toUpperCase()
                });
            }
        });

        exec('asterisk -rx "sip show peers"', (err, stdout) => {
            if (!err && stdout) {
                stdout.split('\n').forEach(line => {
                    const match = line.match(/^([^\s\/]+)(?:\/[^\s]+)?\s+([\d\.]+|\(Unspecified\))\s+/);
                    if (match) {
                        const peer = match[1].trim();
                        if (peer !== 'Name' && !extSet.has(peer) && !peer.startsWith('ds')) {
                            if (!trunkMap.has(peer)) {
                                trunkMap.set(peer, { key: peer, name: peer, tech: 'SIP' });
                            }
                        }
                    }
                });
            }
            res.json(Array.from(trunkMap.values()));
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Trunk error' });
    }
});

// 3. Connect to Asterisk Manager Interface (AMI)
const ami = new AsteriskManager(5038, '127.0.0.1', 'admin', 'admin', true);
ami.keepConnected();

let activeChannels = {};
let extStatuses = {};
let callStartTimes = {};
let regStatuses = {}; // { '14135': { registered: true, ip: '192.168.1.50', regSince: 1732432000000 } }

// Extract peer/extension name from channel string
function extractPeer(channel) {
    if (!channel) return null;
    const match = channel.match(/^(?:PJSIP|SIP|IAX2)\/([^-\/@]+)/i);
    return match ? match[1] : null;
}

// Update registration state, IP address, and registration start timestamp
function updatePeerRegState(peer, isReg, ip) {
    const prev = regStatuses[peer];
    const now = Date.now();
    const regSince = isReg ? (prev && prev.registered && prev.regSince ? prev.regSince : now) : null;

    if (!prev || prev.registered !== isReg || prev.ip !== ip) {
        regStatuses[peer] = { registered: isReg, ip, regSince };
        io.emit('reg_status', { peer, registered: isReg, ip, regSince });
    }
}

// Poll SIP and PJSIP registration states and IP addresses via Asterisk CLI
function pollRegistrations() {
    // Check chan_sip peers
    exec('asterisk -rx "sip show peers"', (err, stdout) => {
        if (err || !stdout) return;
        stdout.split('\n').forEach(line => {
            const match = line.match(/^([^\s\/]+)(?:\/[^\s]+)?\s+([^\s]+)\s+.*\b(OK|Unmonitored|UNREACHABLE|UNKNOWN)\b/i);
            if (match) {
                const peer = match[1].trim();
                const rawIp = match[2].trim();
                const status = match[3].toUpperCase();
                if (peer === 'Name') return;

                const isReg = (rawIp !== '(Unspecified)' && (status === 'OK' || status === 'UNMONITORED'));
                const ip = isReg ? rawIp : '';
                updatePeerRegState(peer, isReg, ip);
            }
        });
    });

    // Check PJSIP endpoints and contacts
    exec('asterisk -rx "pjsip show contacts"', (cErr, cStdout) => {
        const pjsipIps = {};
        if (!cErr && cStdout) {
            cStdout.split('\n').forEach(line => {
                const cMatch = line.match(/Contact:\s+([^\s\/]+)\/sip:[^@]+@([\d\.]+)(?::\d+)?/i);
                if (cMatch) {
                    pjsipIps[cMatch[1].trim()] = cMatch[2].trim();
                }
            });
        }

        exec('asterisk -rx "pjsip show endpoints"', (err, stdout) => {
            if (err || !stdout) return;
            stdout.split('\n').forEach(line => {
                const match = line.match(/^\s*Endpoint:\s+([^\s\/]+)(?:\/\S+)?\s+(Not in use|In use|Ringing|Busy|Unavailable)/i);
                if (match) {
                    const peer = match[1].trim();
                    const state = match[2].toLowerCase();
                    const isReg = (state !== 'unavailable');
                    const ip = isReg ? (pjsipIps[peer] || '') : '';
                    updatePeerRegState(peer, isReg, ip);
                }
            });
        });
    });
}

// Track new channel creation
ami.on('newchannel', (evt) => {
    const peer = extractPeer(evt.channel);
    if (!peer) return;
    activeChannels[peer] = evt.channel;
    const state = evt.channelstatedesc === 'Up' ? 'INCALL' : 'RINGING';
    extStatuses[peer] = state;
    if (state === 'INCALL' && !callStartTimes[peer]) {
        callStartTimes[peer] = Date.now();
    }
    io.emit('ext_status', { exten: peer, status: state, startTime: callStartTimes[peer] || null });
});

// Track channel state transitions (Ringing / Up)
ami.on('newstate', (evt) => {
    const peer = extractPeer(evt.channel);
    if (!peer) return;
    activeChannels[peer] = evt.channel;
    let state = 'IDLE';
    if (evt.channelstatedesc === 'Ringing' || evt.channelstatedesc === 'Ring') {
        state = 'RINGING';
    } else if (evt.channelstatedesc === 'Up') {
        state = 'INCALL';
        if (!callStartTimes[peer]) {
            callStartTimes[peer] = Date.now();
        }
    }
    extStatuses[peer] = state;
    io.emit('ext_status', { exten: peer, status: state, startTime: callStartTimes[peer] || null });
});

// Track channel hangup
ami.on('hangup', (evt) => {
    const peer = extractPeer(evt.channel);
    if (!peer) return;
    delete activeChannels[peer];
    delete callStartTimes[peer];
    extStatuses[peer] = 'IDLE';
    io.emit('ext_status', { exten: peer, status: 'IDLE', startTime: null });
});

// Handle Socket.io client connections and control actions
io.on('connection', (socket) => {
    socket.emit('initial_state', {
        statuses: extStatuses,
        startTimes: callStartTimes,
        registrations: regStatuses
    });
    pollRegistrations();

    // Hangup active call on target extension
    socket.on('action_hangup', ({ exten }) => {
        const chan = activeChannels[exten];
        if (chan) {
            ami.action({ action: 'Hangup', channel: chan });
        }
    });

    // Force hangup hung channels and reset extension card state to IDLE
    socket.on('action_reset', ({ exten }) => {
        if (!exten) return;
        const chan = activeChannels[exten];
        if (chan) {
            ami.action({ action: 'Hangup', channel: chan });
        }
        exec(`asterisk -rx "core show channels concise" | grep -E "^(PJSIP|SIP)/${exten}-" | cut -d'!' -f1`, (err, stdout) => {
            if (!err && stdout) {
                stdout.split('\n').map(c => c.trim()).filter(Boolean).forEach(ch => {
                    exec(`asterisk -rx "channel request hangup ${ch}"`);
                });
            }
        });

        delete activeChannels[exten];
        delete callStartTimes[exten];
        extStatuses[exten] = 'IDLE';
        io.emit('ext_status', { exten, status: 'IDLE', startTime: null });
        pollRegistrations();
    });
});

// Run registration sync immediately and every 3 seconds
pollRegistrations();
setInterval(pollRegistrations, 3000);

server.listen(3050, () => {
    console.log('Operator Panel Server running on port 3050');
});
