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

        if (messages.lengt
