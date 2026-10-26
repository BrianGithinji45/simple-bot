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

const DELAY_BEFORE_TYPING = 8000 // 8 sec wait
const TYPING_DURATION = 10000 // typing 10 sec

app.get("/", async (req, res) => {
    if (!latestQR) return res.send(`<h1>Bot Online ✅ Always Online Active</h1><p>Even if your phone is OFF, bot stays online. Anti-Delete + Anti ViewOnce + Fake Typing 8s+10s working.</p>`)
    const qrImage = await QRCode.toDataURL(latestQR)
    res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;background:#111;color:#fff;height:100vh;justify-content:center;font-family:sans-serif"><h2>Scan QR</h2><img src="${qrImage}" style="width:320px;border:10px solid #fff;border-radius:20px"/><p>After scan, copy SESSION ID from Render logs and add to ENV</p></body></html>`)
})
app.listen(PORT, () => console.log("Web up"))

// KEEP RENDER FROM SLEEPING - THIS IS WHAT MAKES ALWAYS ONLINE WORK
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_URL) fetch(process.env.RENDER_EXTERNAL_URL).catch(()=>{})
    console.log("Always Online ping: available")
}, 20000)

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Chrome","Chrome","121"],
        markOnlineOnConnect: true,
    })

    const keepOnline = () => sock.sendPresenceUpdate('available').catch(()=>{})
    
    // FORCE ALWAYS ONLINE EVERY 5 SECONDS
    sock.ev.on('connection.update', (u) => {
        if (u.qr) latestQR = u.qr
        if (u.connection === 'open') {
            latestQR = null
            console.log("PAIRED ✅ Bot will stay online even if phone off")
            setInterval(keepOnline, 5000)
            keepOnline()

            // PRINT SESSION ID FOR YOU TO SAVE - THIS REPLACES DISK
            try {
                const creds = fs.readFileSync('auth_info_baileys/creds.json')
                const b64 = Buffer.from(creds).toString('base64')
                console.log("\n\n--- COPY THIS SESSION_ID AND PUT IN RENDER ENV ---\n")
                console.log(b64)
                console.log("\n--- END SESSION_ID ---\n\n")
            } catch {}
        }
        if (u.connection === 'close') {
            const shouldReconnect = (u.lastDisconnect?.error instanceof Boom) ? u.lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true
            if (shouldReconnect) startBot()
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue
            const jid = msg.key.remoteJid
            messageStore.set(msg.key.id, msg)

            // ANTI VIEW ONCE
            try {
                const vo = msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessage
                if (vo?.message) {
                    let buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino(), reuploadRequest: sock.updateMediaMessage })
                    const type = Object.keys(vo.message)[0]
                    if (type === 'imageMessage') await sock.sendMessage(jid, { image: buffer, caption: "*Anti ViewOnce*" })
                    if (type === 'videoMessage') await sock.sendMessage(jid, { video: buffer, caption: "*Anti ViewOnce*" })
                }
            } catch {}

            // TYPING LOGIC: WAIT 8 SEC -> TYPING 10 SEC
            if (jid !== 'status@broadcast') {
                setTimeout(async () => {
                    await sock.sendPresenceUpdate('composing', jid)
                    const loop = setInterval(() => sock.sendPresenceUpdate('composing', jid).catch(()=>{}), 3000)
                    setTimeout(async () => {
                        clearInterval(loop)
                        await sock.sendPresenceUpdate('paused', jid)
                    }, TYPING_DURATION)
                }, DELAY_BEFORE_TYPING)
            }
        }
    })

    sock.ev.on('messages.update', async (updates) => {
        for (const up of updates) {
            if (up.update.message === null && messageStore.has(up.key.id)) {
                const old = messageStore.get(up.key.id)
                const jid = old.key.remoteJid
                const content = old.message?.conversation || old.message?.extendedTextMessage?.text || "media deleted"
                await sock.sendMessage(jid, { text: `*Anti-Delete* 🚫\n${content}` })
            }
        }
    })
}

// RESTORE SESSION FROM ENV IF EXISTS (NO DISK NEEDED)
if (process.env.SESSION_ID) {
    if (!fs.existsSync('auth_info_baileys')) fs.mkdirSync('auth_info_baileys')
    const creds = Buffer.from(process.env.SESSION_ID, 'base64').toString()
    fs.writeFileSync('auth_info_baileys/creds.json', creds)
    console.log("Session restored from ENV - no QR needed")
}

startBot()
