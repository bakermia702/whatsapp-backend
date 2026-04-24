const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const express = require('express')
const cors = require('cors')
const QRCode = require('qrcode')
const pino = require('pino')

const app = express()
app.use(cors())
app.use(express.json())

let sock = null
let qrCodeData = null
let connectionStatus = 'disconnected'
let messages = []

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr)
      connectionStatus = 'qr_ready'
      console.log('QR Code ready')
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      connectionStatus = 'disconnected'
      if (shouldReconnect) {
        setTimeout(connectWhatsApp, 3000)
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected'
      qrCodeData = null
      console.log('WhatsApp connected!')
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
        const id = msg.key.id

        messages.unshift({
          id,
          from,
          name,
          text,
          time: new Date().toISOString(),
          replied: false,
          aiSuggestion: null
        })

        if (messages.length > 100) messages = messages.slice(0, 100)
        console.log(`New message from ${name}: ${text}`)
      }
    }
  })
}

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

app.post('/ai-suggest', async (req, res) => {
  const { customerMessage, businessContext } = req.body
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `তুমি একজন কাস্টমার সার্ভিস এক্সপার্ট। ব্যবসার বিষয়: ${businessContext || 'সাধারণ ব্যবসা'}। 
কাস্টমারের মেসেজ: "${customerMessage}"
একটি সংক্ষিপ্ত, বাংলায় প্রফেশনাল রিপ্লাই লেখো।`
        }]
      })
    })
    const data = await response.json()
    res.json({ suggestion: data.content[0].text })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(3000, () => {
  console.log('Server running on port 3000')
  connectWhatsApp()
})
