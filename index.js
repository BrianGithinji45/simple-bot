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

// YOUR TIMING
const DELAY_BEFORE_TYPING = 8000 // wait 8 sec after receiving
const TYPING_DURATION = 10000 // typing for 10 sec

// ===== WEB SERVER FOR QR =====
app.get("/", async (req, res) => {
    if (!latestQR) {
        return res.send(`
        <html><body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center">
        <h1>✅ Bot Deployed & Always Online Active</h1>
        <p>Anti-Delete | Anti ViewOnce | Fake Typing 8s + 10s</p>
        <p style="margin-top:20px;color:#888">If you unlinked your phone, click reset below</p>
        <a href="/reset" style="margin-top:15px;padding:12px 20px;background:red;color:white;border-radius:10px;text-decoration:none;font-weight:bold">RESET BOT & GET NEW QR</a>
        <p style="margin-top:20px;font-size:12px;color:#555">Even if phone is OFF, bot stays online</p>
        </body></html>`)
    }
    if (latestQR === "RESET_DONE") {
        return res.send(`<h1>Resetting... wait 10 sec and refresh</h1>`)
    }
    try {
        const qrImage = await QRCode.toDataURL(latestQR)
        res.send(`
        <html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:white;text-align:center">
            <h2>Scan This QR to Link</h2>
            <p>WhatsApp > Settings > Linked Devices > Link a Device</p>
            <img src="${qrImage}" style="width:320px;border:12px solid white;border-radius:20px"/>
            <p style="margin-top:15px;color:#0f0">QR expires in 30 sec - refresh page for new QR</p>
            <a href="/reset" style="margin-top:20px;color:red">Reset if QR not working</a>
        </body></html>`)
    } catch (e) { res.send("Error QR") }
})

// RESET ROUTE - FIXES YOUR CURRENT ISSUE
app.get("/reset", (req, res) => {
    try {
        if (fs.existsSync('auth_info_baileys')) {
            fs.rmSync('auth_info_baileys', { recursive: true, force: true })
        }
        latestQR = "RESET_DONE"
        res.send(`
        <html><body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
        <h1>✅ Reset Done</h1>
        <p>Now do this:</p>
        <p>1. Go to Render > Environment > DELETE SESSION_ID</p>
        <p>2. Go to Manual Deploy > Deploy latest commit</p>
        <p>3. Come back to / to scan new QR</p>
        </body></html>`)
        setTimeout(() => {
            console.log("Resetting bot...")
            process.exit(0)
        }, 3000)
    } catch (e) {
        res.send("Reset error: " + e.message)
    }
})

app.listen(PORT, () => console.log(`Web running on ${PORT}`))

// KEEP RENDER AWAKE FOR ALWAYS ONLINE
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_URL) {
        fetch(process.env.RENDER_EXTERNAL_URL).catch(()=>{})
    }
}, 20000)

// RESTORE SESSION FROM ENV (NO DISK)
if (process.env.SESSION_ID) {
    try {
        if (!fs.existsSync('auth_info_baileys')) fs.mkdirSync('auth_info_baileys')
        const creds = Buffer.from(process.env.SESSION_ID, 'base64').toString()
        fs.writeFileSync('auth_info_baileys/creds.json', creds)
        console.log("Session restored from ENV")
    } catch (e) { console.log("Failed to restore session", e.message) }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Chrome","Chrome","121"],
        markOnlineOnConnect: true,
    })

    const keepOnline = () => sock.sendPresenceUpdate('available').catch(()=>{})

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            latestQR = qr
            console.log("New QR - open Render URL to scan")
        }
        if (connection === 'open') {
            latestQR = null
            console.log("PAIRED ✅ Always Online Active")
            setInterval(keepOnline, 5000) // always online every 5 sec
            keepOnline()

            // SHOW SESSION_ID TO SAVE (FOR ALWAYS ONLINE WITHOUT DISK)
            try {
                if (!process.env.SESSION_ID) {
                    const creds = fs.readFileSync('auth_info_baileys/creds.json')
                    const b64 = Buffer.from(creds).toString('base64')
                    console.log("\n\n--- COPY SESSION_ID ---\n" + b64 + "\n--- END SESSION_ID ---\n\n")
                }
            } catch {}
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true
            if (shouldReconnect) startBot()
            else {
                console.log("Logged out - need /reset")
                latestQR = null
            }
        }
    })

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
                    if (type === 'imageMessage') await sock.sendMessage(jid, { image: buffer, caption: "*Anti ViewOnce Detected*" })
                    if (type === 'videoMessage') await sock.sendMessage(jid, { video: buffer, caption: "*Anti ViewOnce Detected*" })
                }
            } catch {}

            // FAKE TYPING: 8 SEC WAIT THEN 10 SEC TYPING
            if (jid !== 'status@broadcast') {
                setTimeout(async () => {
                    await sock.sendPresenceUpdate('composing', jid)
                    const loop = setInterval(() => sock.sendPresenceUpdate('composing', jid).catch(()=>{}), 2500)
                    setTimeout(async () => {
                        clearInterval(loop)
                        await sock.sendPresenceUpdate('paused', jid)
                    }, TYPING_DURATION)
                }, DELAY_BEFORE_TYPING)
            }
        }
    })

    // ANTI DELETE
    sock.ev.on('messages.update', async (updates) => {
        for (const up of updates) {
            if (up.update.message === null && messageStore.has(up.key.id)) {
                const old = messageStore.get(up.key.id)
                const jid = old.key.remoteJid
                const content = old.message?.conversation || old.message?.extendedTextMessage?.text || "media file was deleted"
                await sock.sendMessage(jid, { text: `*Anti-Delete* 🚫\nRecovered: ${content}` })
            }
        }
    })
}

startBot()
