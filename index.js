const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require("@whiskeysockets/baileys")
const { Boom } = require("@hapi/boom")
const express = require("express")
const QRCode = require("qrcode")
const pino = require("pino")

const app = express()
const PORT = process.env.PORT || 3000
let latestQR = null

// CONFIG
const FAKE_TYPING_DELAY = 3000 // fake typing after 3 seconds
const OWNER_JID = "" // optional: 2547xxxx@s.whatsapp.net

let messageStore = new Map()

app.get("/", async (req, res) => {
    if (!latestQR) {
        return res.send("<h2>Bot is Online ✅ Always Online Active<br>No QR needed - already paired</h2><p>If you need new QR, delete auth files in Render and redeploy.</p>")
    }
    try {
        const qrImage = await QRCode.toDataURL(latestQR)
        res.send(`
        <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:white">
            <h2>Scan This QR - 【entity-WhatsApp¦canonical_name=WhatsApp】 Anti Bot</h2>
            <p>【entity-WhatsApp¦canonical_name=WhatsApp】 > Linked Devices > Link a Device > Scan</p>
            <img src="${qrImage}" style="width:300px;border:10px solid white;border-radius:20px"/>
            <p>QR refreshes automatically. Refresh page for new QR</p>
            <p>Features: Anti-Delete | Anti ViewOnce | Fake Typing | Always Online</p>
        </body>
        </html>
        `)
    } catch (e) { res.send("Error generating QR") }
})

app.listen(PORT, () => console.log(`Server running on ${PORT}`))

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Anti Bot", "Chrome", "1.0"],
        markOnlineOnConnect: true,
    })

    // ALWAYS ONLINE LOOP
    setInterval(() => sock.sendPresenceUpdate('available').catch(()=>{}), 15000)

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            latestQR = qr
            console.log("New QR generated - open your Render URL to scan")
        }
        if (connection === 'open') {
            latestQR = null
            console.log("Paired ✅ Bot Online Always")
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true
            if (shouldReconnect) startBot()
            else console.log("Logged out - delete auth_info_baileys and restart")
        }
    })

    // MESSAGES
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message) continue
            const jid = msg.key.remoteJid
            if (!msg.key.fromMe) messageStore.set(msg.key.id, msg)

            // ANTI VIEW ONCE
            try {
                const viewOnce = msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2Extension
                if (viewOnce?.message) {
                    const inner = viewOnce.message
                    const type = Object.keys(inner)[0]
                    console.log("ViewOnce caught:", type)
                    let buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino(), reuploadRequest: sock.updateMediaMessage })
                    const target = OWNER_JID || jid
                    const caption = `*Anti ViewOnce* from @${jid.split('@')[0]}`
                    if (type === 'imageMessage') await sock.sendMessage(target, { image: buffer, caption })
                    if (type === 'videoMessage') await sock.sendMessage(target, { video: buffer, caption })
                    if (type === 'audioMessage') await sock.sendMessage(target, { audio: buffer, ptt: true })
                }
            } catch(e){ console.log("viewonce fail", e.message) }

            // FAKE TYPING AFTER SECONDS
            if (!msg.key.fromMe && jid !== 'status@broadcast') {
                await sock.sendPresenceUpdate('composing', jid)
                await new Promise(r => setTimeout(r, FAKE_TYPING_DELAY))
                await sock.sendPresenceUpdate('paused', jid)
            }
        }
    })

    // ANTI DELETE
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.message === null && messageStore.has(update.key.id)) {
                const oldMsg = messageStore.get(update.key.id)
                const jid = oldMsg.key.remoteJid
                const target = OWNER_JID || jid
                try {
                    let buffer = await downloadMediaMessage(oldMsg, 'buffer', {}, { logger: pino(), reuploadRequest: sock.updateMediaMessage }).catch(()=>null)
                    const text = `*Anti-Delete* 🚫\nSender deleted message`
                    if (oldMsg.message?.imageMessage && buffer) await sock.sendMessage(target, { image: buffer, caption: text })
                    else if (oldMsg.message?.videoMessage && buffer) await sock.sendMessage(target, { video: buffer, caption: text })
                    else {
                        const content = oldMsg.message?.conversation || oldMsg.message?.extendedTextMessage?.text || "Media deleted"
                        await sock.sendMessage(target, { text: `*Anti-Delete* 🚫\nRecovered: ${content}` }, { mentions: [jid] })
                    }
                } catch(e){ console.log(e) }
            }
        }
    })
}

startBot()
