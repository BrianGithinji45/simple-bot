const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require("@whiskeysockets/baileys")
const { Boom } = require("@hapi/boom")
const express = require("express")
const QRCode = require("qrcode")
const pino = require("pino")
const fs = require("fs")

const app = express()
let latestQR = null
let messageStore = new Map()
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_info_baileys'
const PORT = process.env.PORT || 3000

const DELAY_BEFORE_TYPING = 2000
const TYPING_DURATION = 15000

app.get("/", async (req, res) => {
    if (!latestQR) return res.send(`<h1>✅ LIVE ALWAYS ONLINE - Pinging every 5 sec</h1><a href="/session">SESSION</a> | <a href="/reset">RESET</a>`)
    if (latestQR === "RESET_DONE") return res.send(`<h1>Resetting...</h1>`)
    const qrImage = await QRCode.toDataURL(latestQR)
    res.send(`<body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh"><h2>Scan - Live Always Online Bot</h2><img src="${qrImage}" style="width:320px;border:10px solid #fff;border-radius:20px"/></body>`)
})
app.get("/ping", (req, res) => res.send("ALIVE - bot is live pinging every 5 sec"))
app.get("/session", (req, res) => {
    try {
        const b64 = Buffer.from(fs.readFileSync(`${AUTH_FOLDER}/creds.json`)).toString('base64')
        res.send(`<p style="word-break:break-all;background:#111;color:#fff;padding:20px">${b64}</p>`)
    } catch { res.send("No session - scan QR from /") }
})
app.get("/reset", (req, res) => {
    if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
    latestQR = "RESET_DONE"
    res.send("Reset done - delete SESSION_ID in Render Env and redeploy")
    setTimeout(() => process.exit(0), 2000)
})
app.listen(PORT, () => console.log("Web up on " + PORT))

// RESTORE SESSION
if (process.env.SESSION_ID) {
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true })
    fs.writeFileSync(`${AUTH_FOLDER}/creds.json`, Buffer.from(process.env.SESSION_ID, 'base64').toString())
}

// RENDER FREE KEEP ALIVE - PING EVERY 5 SECONDS
setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL
    if (url) {
        fetch(url + "/ping").then(()=>console.log("Self ping 5s")).catch(()=>{})
        fetch(url).catch(()=>{})
    }
    console.log("Ping loop 5 sec")
}, 5000)

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Chrome","Chrome","121"],
        markOnlineOnConnect: true,
    })

    // WHATSAPP ALWAYS ONLINE - PING EVERY 5 SECONDS
    const stayOnline = async () => {
        try {
            await sock.sendPresenceUpdate('available')
            console.log("WhatsApp: set to AVAILABLE (online) - 5s ping")
        } catch {}
    }

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (u) => {
        if (u.qr) latestQR = u.qr
        if (u.connection === 'open') {
            latestQR = null
            console.log("PAIRED ✅ LIVE NOW - pinging WhatsApp every 5 sec")
            stayOnline()
            setInterval(stayOnline, 5000) // WHATSAPP PING EVERY 5 SEC
        }
        if (u.connection === 'close') {
            const shouldReconnect = (u.lastDisconnect?.error instanceof Boom) ? u.lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true
            if (shouldReconnect) startBot()
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message) continue
            const protocol = msg.message.protocolMessage
            if (protocol && protocol.type === 0) {
                const deletedKey = protocol.key
                if (messageStore.has(deletedKey.id)) {
                    const oldMsg = messageStore.get(deletedKey.id)
                    const content = oldMsg.message?.conversation || oldMsg.message?.extendedTextMessage?.text || "media"
                    await sock.sendMessage(oldMsg.key.remoteJid, { text: `*Anti-Delete 🚫* ${content}` })
                }
                continue
            }
            if (!msg.key.fromMe) messageStore.set(msg.key.id, msg)

            try {
                const vo = msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessage
                if (vo?.message) {
                    let buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino(), reuploadRequest: sock.updateMediaMessage })
                    await sock.sendMessage(msg.key.remoteJid, { image: buffer, caption: "*Anti ViewOnce*" })
                }
            } catch {}

            if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
                const jid = msg.key.remoteJid
                setTimeout(async () => {
                    await sock.sendPresenceUpdate('composing', jid)
                    const loop = setInterval(() => sock.sendPresenceUpdate('composing', jid).catch(()=>{}), 2000)
                    setTimeout(async () => { clearInterval(loop); await sock.sendPresenceUpdate('paused', jid) }, TYPING_DURATION)
                }, DELAY_BEFORE_TYPING)
            }
        }
    })
}
startBot()
