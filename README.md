# Issabel 5 Live Operator Panel V1.0.0 (FOP2 Style)

A lightweight, real-time web-based Live Operator Panel designed specifically for **Issabel 5** (Asterisk 18 / PJSIP & SIP). Monitor extensions and trunks in an Elastix 4-inspired compact grid with real-time IP addresses, registration uptime timers, active call durations, hangup controls, and hung-channel reset capabilities.

## Key Features

- **Elastix 4 Compact Card Grid:** Clean, high-density card layout for both Extensions and SIP/IAX Trunks.
- **Real-Time Call Status:** Instant visual indicators for `IDLE`, `RINGING`, and `INCALL` states via Asterisk Manager Interface (AMI) and WebSockets.
- **Live Active Call Timer:** Real-time duration counter (`MM:SS` / `HH:MM:SS`) for ongoing calls.
- **Registration Status & Uptime Timer:** Shows live `Registered` / `Unregistered` badges, registered IP addresses, and continuous registration uptime (`Up HH:MM:SS`).
- **One-Click Call Controls:** Hangup active calls or force-reset stuck/hung extension channels back to `IDLE`.
- **Native Issabel Web GUI Integration:** Appears directly under **PBX $\rightarrow$ Live Operator Panel** inside the Issabel admin portal.

---

## One-Line Installation on Any Issabel 5 Server

Log in to your Issabel 5 server via SSH as `root` and run the following single command:

```bash
rm -rf /tmp/op-panel && mkdir -p /tmp/op-panel && curl -sL [https://github.com/sagarroy17/issabel5-live-operator-panel/archive/refs/heads/main.tar.gz](https://github.com/sagarroy17/issabel5-live-operator-panel/archive/refs/heads/main.tar.gz) | tar -xz -C /tmp/op-panel --strip-components=1 && bash /tmp/op-panel/install.sh
