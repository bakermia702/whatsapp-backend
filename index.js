const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const express = require('express')
const cors = require('cors')
const QRCode = require('qrcode')
const pino = require('pino')
const fs = require('fs')

const app = express()
app.use(cors())
app.use(express.json())

let sock = null
let qrCodeData = null
let connectionStatus = 'disconnected'
let messages = []

// In-memory auth store (Railway ফাইল সেভ করতে পারে না তাই)
const authState = {
  creds: null,
  keys: {}
}

async function connectWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth_info')

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['WhatsApp Support', 'Chrome', '1.0.0']
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      console.log('Connection update:', connection, qr ? 'QR received' : '')

      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr)
        connectionStatus = 'qr_ready'
        console.log('QR Code generated!')
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = code !== DisconnectReason.loggedOut
        connectionStatus = 'disconnected'
        qrCodeData = null
        console.log('Connection closed, code:', code)
        if (shouldReconnect) {
          console.log('Reconnecting...')
          setTimeout(connectWhatsApp, 3000)
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected'
        qrCodeData = null
        console.log('WhatsApp connected successfully!')
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
            replied: false
          })

          if (messages.length > 100) messages = messages.slice(0, 100)
          console.log(`Message from ${name}: ${text}`)
        }
      }
    })

  } catch (err) {
    console.log('Error connecting:', err.message)
    setTimeout(connectWhatsApp, 5000)
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'running', whatsapp: connectionStatus })
})

app.get('/qr', (req, res) => {
  res.json({ status: connectionStatus, qr: qrCodeData })
})

app.get('/messages', (req, res) => {
  res.json(messages)
})

app.post('/reply', async (req, res) => {
  const { to, text } = req.body
  if (!sock || connectionStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected' })
  }
  try {
    await sock.sendMessage(to, { text })
    messages = messages.map(m => m.from === to ? { ...m, replied: true } : m)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  connectWhatsApp()
})
