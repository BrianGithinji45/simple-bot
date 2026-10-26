const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require("@whiskeysockets/baileys")
const { Boom } = require("@hapi/boom")
const express = require("express")
const QRCode = require("qrcode")
const pino = require("pino")
const fs = require("fs")

const app = express()
const PORT = process.env.PORT || 3000
let latestQR = null
let messageStore = new Map()
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_info_baileys'

const DELAY_BEFORE_TYPING = 2000 // wait 8 sec after message
const TYPING_DURATION = 15000 // typing for 10 sec

// --- WEB SERVER ---
app.get("/", async (req, res) => {
    if (!latestQR) {
        return res.send(`<html><body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center">
        <h1>✅ LIVE ALWAYS ONLINE</h1><p>Ping every 5s | Anti-Delete Fixed | Anti ViewOnce | Typing 8s+10s</p>
        <p>Checked by UptimeRobot: https://simple-bot-1-4cql.onrender.com/ping</p>
        <a href="/session" style="margin:10px;padding:12px 20px;background:#0f0;color:#000;border-radius:10px;text-decoration:none;font-weight:bold">GET SESSION_ID</a>
        <a href="/reset" style="margin:10px;padding:12px 20px;background:red;color:#fff;border-radius:10px;text-decoration:none">RESET QR</a>
        <p style="margin-top:20px;color:#888">Even if phone OFF, bot stays online</p>
        </body></html>`)
    }
    if (latestQR === "RESET_DONE") return res.send(`<h1>Resetting... refresh in 10 sec</h1>`)
    const qrImage = await QRCode.toDataURL(latestQR)
    res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#111;color:#fff;text-align:center"><h2>Scan QR - Live Bot</h2><img src="${qrImage}" style="width:320px;border:12px solid #fff;border-radius:20px"/><p>WhatsApp > Linked Devices > Link a Device</p></body></html>`)
})

app.get("/ping", (req, res) => res.send("ALIVE - Bot Live Always Online Ping 5s"))
app.get("/session", (req, res) => {
    try {
        const b64 = Buffer.from(fs.readFileSync(`${AUTH_FOLDER}/creds.json`)).toString('base64')
        res.send(`<html><body style="background:#111;color:#fff;font-family:monospace;padding:20px;word-break:break-all"><h2>SESSION_ID - Copy This Whole Code</h2><div style="background:#222;padding:15px;border-radius:10px;">${b64}</div><br><a href="/" style="color:#0f0">Back Home</a></body></html>`)
    } catch (e) { res.send("No session yet - Scan QR from / first. Error: " + e.message) }
})
app.get("/reset", (req, res) => {
    if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
    latestQR = "RESET_DONE"
    res.send(`<h1>✅ Reset Done</h1><p>1. Delete SESSION_ID in Render > Environment</p><p>2. Redeploy</p><p>3. Open / for new QR</p>`)
    setTimeout(() => process.exit(0), 2000)
})
app.listen(PORT, () => console.log("Web on " + PORT))

// Restore session from ENV - NO DISK NEEDED
if (process.env.SESSION_ID) {
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true })
    fs.writeFileSync(`${AUTH_FOLDER}/creds.json`, Buffer.from(process.env.SESSION_ID, 'base64').toString())
    console.log("Session restored from ENV")
}

// SELF PING EVERY 5 SEC FOR ALWAYS ONLINE
setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL
    if (url) fetch(url + "/ping").catch(()=>{})
}, 5000)

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Chrome","Chrome","121"],
        markOnlineOnConnect: true,
        syncFullHistory: true
    })

    // ALWAYS ONLINE EVERY 5 SEC
    const stayOnline = () => sock.sendPresenceUpdate('available').catch(()=>{})

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (u) => {
        if (u.qr) latestQR = u.qr
        if (u.connection === 'open') {
            latestQR = null
            console.log("PAIRED ✅ LIVE ALWAYS - pinging every 5s")
            stayOnline()
            setInterval(stayOnline, 5000)
            try {
                if (!process.env.SESSION_ID) {
                    const b64 = Buffer.from(fs.readFileSync(`${AUTH_FOLDER}/creds.json`)).toString('base64')
                    console.log("\n--- COPY SESSION_ID ---\n" + b64 + "\n--- END ---\n")
                }
            } catch {}
        }
        if (u.connection === 'close') {
            const shouldReconnect = (u.lastDisconnect?.error instanceof Boom) ? u.lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true
            if (shouldReconnect) startBot()
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message) continue

            // ANTI-DELETE FIXED
            const protocol = msg.message.protocolMessage
            if (protocol && protocol.type === 0) {
                const delKey = protocol.key
                if (messageStore.has(delKey.id)) {
                    const oldMsg = messageStore.get(delKey.id)
                    const content = oldMsg.message?.conversation || oldMsg.message?.extendedTextMessage?.text || oldMsg.message?.imageMessage?.caption || "media"
                    try {
                        if (oldMsg.message?.imageMessage || oldMsg.message?.videoMessage) {
                            let buf = await downloadMediaMessage(oldMsg, 'buffer', {}, { logger: pino(), reuploadRequest: sock.updateMediaMessage })
                            if (oldMsg.message?.imageMessage) await sock.sendMessage(oldMsg.key.remoteJid, { image: buf, caption: `*Anti-Delete 🚫*\nRecovered: ${content}` })
                            else await sock.sendMessage(oldMsg.key.remoteJid, { video: buf, caption: `*Anti-Delete 🚫*` })
                        } else {
                            await sock.sendMessage(oldMsg.key.remoteJid, { text: `*Anti-Delete 🚫*\nThey deleted: ${content}` })
                        }
                    } catch { await sock.sendMessage(oldMsg.key.remoteJid, { text: `*Anti-Delete 🚫*\nRecovered: ${content}` }) }
                }
                continue
            }

            if (!msg.key.fromMe) messageStore.set(msg.key.id, msg)

            // ANTI VIEWONCE
            try {
                const vo = msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessage
                if (vo?.message) {
                    let buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino(), reuploadRequest: sock.updateMediaMessage })
                    const type = Object.keys(vo.message)[0]
                    if (type === 'imageMessage') await sock.sendMessage(msg.key.remoteJid, { image: buf, caption: "*Anti ViewOnce*" })
                    if (type === 'videoMessage') await sock.sendMessage(msg.key.remoteJid, { video: buf, caption: "*Anti ViewOnce*" })
                }
            } catch {}

            // FAKE TYPING 8s wait + 10s typing
            if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
                const jid = msg.key.remoteJid
                setTimeout(async () => {
                    await sock.sendPresenceUpdate('composing', jid)
                    const loop = setInterval(() => sock.sendPresenceUpdate('composing', jid).catch(()=>{}), 2500)
                    setTimeout(async () => { clearInterval(loop); await sock.sendPresenceUpdate('paused', jid) }, TYPING_DURATION)
                }, DELAY_BEFORE_TYPING)
            }
        }
    })
}
startBot()
