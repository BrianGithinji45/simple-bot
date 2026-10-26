const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require("@whiskeysockets/baileys")
const { Boom } = require("@hapi/boom")
const express = require("express")
const QRCode = require("qrcode")
const pino = require("pino")

const app = express()
const PORT = process.env.PORT || 3000
let latestQR = null

// CONFIG - YOU CAN EDIT THESE
const DELAY_BEFORE_TYPING = 8000 // 8 seconds after receiving text
const TYPING_DURATION = 10000 // show typing for 10 seconds
const OWNER_JID = "" 

let messageStore = new Map()

app.get("/", async (req, res) => {
    if (!latestQR) {
        return res.send(`<html><body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><h1>Bot Online ✅ Always Online Active</h1><p>Anti-Delete | Anti ViewOnce | Fake Typing 8s + 10s</p><p>No QR needed - already linked</p></body></html>`)
    }
    const qrImage = await QRCode.toDataURL(latestQR)
    res.send(`
    <html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:white">
        <h2>Scan This QR - WhatsApp Bot</h2>
        <img src="${qrImage}" style="width:320px;border:10px solid white;border-radius:20px"/>
        <p>Link: WhatsApp > Linked Devices > Link a Device</p>
    </body></html>`)
})

app.listen(PORT, () => console.log(`Server on ${PORT}`))

// KEEP RENDER AWAKE - important for always online
const RENDER_URL = process.env.RENDER_EXTERNAL_URL
if (RENDER_URL) {
    setInterval(() => {
        fetch(RENDER_URL).then(()=> console.log("Self-ping to stay awake")).catch(()=>{})
    }, 4 * 60 * 1000) // ping every 4 mins
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Chrome", "Chrome", "121"],
        markOnlineOnConnect: true,
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => false
    })

    // ALWAYS ONLINE - THE REAL FIX
    const keepOnline = async () => {
        try {
            await sock.sendPresenceUpdate('available')
            // also set it for all chats to make you look online everywhere
            await sock.sendPresenceUpdate('available')
        } catch {}
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            latestQR = qr
            console.log("New QR - open your Render URL")
        }
        if (connection === 'open') {
            latestQR = null
            console.log("Paired ✅")
            keepOnline()
            // start 5 second loop ONLY after connection open
            setInterval(keepOnline, 5000)
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true
            if (shouldReconnect) startBot()
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue
            const jid = msg.key.remoteJid
            messageStore.set(msg.key.id, msg)

            // ANTI VIEW ONCE
            try {
                const viewOnce = msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessage
                if (viewOnce?.message) {
                    const inner = viewOnce.message
                    const type = Object.keys(inner)[0]
                    let buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino(), reuploadRequest: sock.updateMediaMessage })
                    const target = OWNER_JID || jid
                    if (type === 'imageMessage') await sock.sendMessage(target, { image: buffer, caption: `*Anti ViewOnce*` })
                    if (type === 'videoMessage') await sock.sendMessage(target, { video: buffer, caption: `*Anti ViewOnce*` })
                    if (type === 'audioMessage') await sock.sendMessage(target, { audio: buffer, ptt: true })
                }
            } catch {}

            // FAKE TYPING LOGIC: 8 sec wait -> typing 10 sec
            if (jid !== 'status@broadcast') {
                console.log(`Message received, waiting ${DELAY_BEFORE_TYPING}ms before typing...`)
                
                setTimeout(async () => {
                    try {
                        console.log("Now showing typing for 10 sec")
                        await sock.sendPresenceUpdate('composing', jid)
                        
                        // Keep sending composing every 3 sec so it doesn't stop
                        const typingInterval = setInterval(() => {
                            sock.sendPresenceUpdate('composing', jid).catch(()=>{})
                        }, 3000)

                        setTimeout(async () => {
                            clearInterval(typingInterval)
                            await sock.sendPresenceUpdate('paused', jid)
                            console.log("Stopped typing")
                        }, TYPING_DURATION)

                    } catch {}
                }, DELAY_BEFORE_TYPING)
            }
        }
    })

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.message === null && messageStore.has(update.key.id)) {
                const oldMsg = messageStore.get(update.key.id)
                const jid = oldMsg.key.remoteJid
                const target = OWNER_JID || jid
                try {
                    let buffer = await downloadMediaMessage(oldMsg, 'buffer', {}, { logger: pino(), reuploadRequest: sock.updateMediaMessage }).catch(()=>null)
                    if (oldMsg.message?.imageMessage && buffer) await sock.sendMessage(target, { image: buffer, caption: `*Anti-Delete* Recovered Image` })
                    else if (oldMsg.message?.videoMessage && buffer) await sock.sendMessage(target, { video: buffer, caption: `*Anti-Delete* Recovered Video` })
                    else {
                        const content = oldMsg.message?.conversation || oldMsg.message?.extendedTextMessage?.text || "media"
                        await sock.sendMessage(target, { text: `*Anti-Delete* 🚫\nRecovered: ${content}` })
                    }
                } catch {}
            }
        }
    })
}

startBot()
