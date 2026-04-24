const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const express = require('express')
const cors = require('cors')
const QRCode = require('qrcode')
const pino = require('pino')
const NodeCache = require('node-cache')

const app = express()
app.use(cors())
app.use(express.json())

let sock = null
let qrCodeData = null
let connectionStatus = 'disconnected'
let messages = []
const msgRetryCounterCache = new NodeCache()

async function connectWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth_info')

    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      msgRetryCounterCache,
      defaultQueryTimeoutMs: undefined,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 2000
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      console.log('Update:', JSON.stringify({ connection, qr: !!qr }))

      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr)
        connectionStatus = 'qr_ready'
        console.log('QR ready!')
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        console.log('Closed, code:', code)
        connectionStatus = 'disconnected'
        qrCodeData = null

        if (code === DisconnectReason.loggedOut) {
          console.log('Logged out, clearing session...')
          const fs = require('fs')
          try { fs.rmSync('/tmp/auth_info', { recursive: true }) } catch(e) {}
          setTimeout(connectWhatsApp, 2000)
        } else {
          setTimeout(connectWhatsApp, 5000)
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected'
        qrCodeData = null
        console.log('Connected!')
      }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages: newMessages }) => {
      for (const msg of newMessages) {
        if (!msg.key.fromMe && msg.message) {
          const text = msg.message?.conversation ||
                       msg.message?.extendedTextMessage?.text || ''
          const from = msg.key.remoteJid
          const name = msg.pushName || 'Unknown'

          messages.unshift({
            id: msg.key.id,
            from,
            name,
            text,
            time: new Date().toISOString(),
            replied: false,
            sent: false
          })

          if (messages.length > 200) messages = messages.slice(0, 200)
        }
      }
    })

  } catch (err) {
    console.log('Error:', err.message)
    setTimeout(connectWhatsApp, 5000)
  }
}

app.get('/', (req, res) => res.json({ status: 'ok', whatsapp: connectionStatus }))
app.get('/qr', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData }))
app.get('/messages', (req, res) => res.json(messages))

app.post('/reply', async (req, res) => {
  const { to, text } = req.body
  if (!sock || connectionStatus !== 'connected') {
    return res.status(400).json({ error: 'Not connected' })
  }
  try {
    await sock.sendMessage(to, { text })

    // Sent message ও list এ রাখো
    messages.unshift({
      id: Date.now().toString(),
      from: 'me',
      to: to,
      name: 'You',
      text: text,
      time: new Date().toISOString(),
      replied: true,
      sent: true
    })

    // কাস্টমারের সব মেসেজ replied মার্ক করো
    messages = messages.map(m => m.from === to ? { ...m, replied: true } : m)

    if (messages.length > 200) messages = messages.slice(0, 200)

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('Server on port', PORT)
  connectWhatsApp()
})
