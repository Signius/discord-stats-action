#!/usr/bin/env node
import { Client, GatewayIntentBits } from 'discord.js'
import fs from 'fs'
import path from 'path'

// —— Config from env / GitHub Action inputs ——
const DISCORD_TOKEN = process.env.INPUT_DISCORD_TOKEN || process.env.DISCORD_TOKEN
const GUILD_ID      = process.env.INPUT_GUILD_ID      || process.env.GUILD_ID

const OUTPUT_FILE =
  process.env.INPUT_OUTPUT_FILE ||
  process.env.OUTPUT_FILE ||
  path.resolve(process.cwd(), 'data/discord-stats/stats.json')

const BACKFILL      = (process.env.INPUT_BACKFILL      || process.env.BACKFILL      || 'false') === 'true'
const BACKFILL_YEAR = Number(process.env.INPUT_BACKFILL_YEAR || process.env.BACKFILL_YEAR) || new Date().getFullYear()

// Validate required inputs 
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('❌ DISCORD_TOKEN (or INPUT_DISCORD_TOKEN) and GUILD_ID (or INPUT_GUILD_ID) must be set')
  process.exit(1)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
})

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`)
  const guild = await client.guilds.fetch(GUILD_ID)
  const memberCount = guild.memberCount

  // Load existing data
  let data = {}
  if (fs.existsSync(OUTPUT_FILE)) {
    data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
  }

  const channels = guild.channels.cache
    .filter(c => c.isTextBased() && c.viewable)
    .values()

  const now = new Date()

  if (BACKFILL) {
    console.log(`🔄 Backfilling Jan → last full month of ${BACKFILL_YEAR}`)

    const buckets = {}
    const startDate = new Date(BACKFILL_YEAR, 0, 1)
    const endDate   = new Date(now.getFullYear(), now.getMonth(), 1)

    for (const channel of channels) {
      // Main channel messages
      let lastId = null
      outer: while (true) {
        const msgs = await channel.messages.fetch({ limit: 100, before: lastId })
        if (!msgs.size) break
        for (const msg of msgs.values()) {
          const ts = msg.createdAt
          if (ts < startDate) break outer
          if (ts < endDate) {
            const key = `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}`
            if (!buckets[key]) buckets[key] = { totalMessages: 0, uniquePosters: new Set() }
            buckets[key].totalMessages++
            if (!msg.author.bot) buckets[key].uniquePosters.add(msg.author.id)
          }
        }
        lastId = msgs.last()?.id
        if (!lastId) break
        await new Promise(r => setTimeout(r, 500))
      }

      // Threads (active + archived)
      if (channel.threads) {
        const pools = [
          await channel.threads.fetchActive(),
          await channel.threads.fetchArchived({ limit: 100 })
        ]
        for (const pool of pools) {
          for (const thread of pool.threads.values()) {
            let threadLastId = null
            while (true) {
              const msgs = await thread.messages.fetch({ limit: 100, before: threadLastId })
              if (!msgs.size) break
              for (const msg of msgs.values()) {
                const ts = msg.createdAt
                if (ts < startDate) break
                if (ts < endDate) {
                  const key = `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}`
                  if (!buckets[key]) buckets[key] = { totalMessages: 0, uniquePosters: new Set() }
                  buckets[key].totalMessages++
                  if (!msg.author.bot) buckets[key].uniquePosters.add(msg.author.id)
                }
              }
              threadLastId = msgs.last()?.id
              if (!threadLastId) break
              await new Promise(r => setTimeout(r, 500))
            }
          }
        }
      }
    }

    // Populate data
    for (let m = 0; m < now.getMonth(); m++) {
      const dt  = new Date(BACKFILL_YEAR, m, 1)
      const key = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`
      const stats = buckets[key] || { totalMessages: 0, uniquePosters: new Set() }
      data[key] = {
        memberCount,
        totalMessages: stats.totalMessages,
        uniquePosters: stats.uniquePosters.size
      }
      console.log(`  → ${key}: ${stats.totalMessages} msgs, ${stats.uniquePosters.size} uniquePosters, ${memberCount} members`)
    }

  } else {
    // Last-month only
    const monthStart = new Date(now.getFullYear(), now.getMonth()-1, 1)
    const monthEnd   = new Date(now.getFullYear(), now.getMonth(), 1)
    const key        = `${monthStart.getFullYear()}-${String(monthStart.getMonth()+1).padStart(2,'0')}`

    let totalMessages = 0
    const uniquePostersSet = new Set()

    for (const channel of channels) {
      let lastId = null
      while (true) {
        const msgs = await channel.messages.fetch({ limit: 100, before: lastId })
        if (!msgs.size) break
        for (const msg of msgs.values()) {
          const ts = msg.createdAt
          if (ts >= monthStart && ts < monthEnd) {
            totalMessages++
            if (!msg.author.bot) uniquePostersSet.add(msg.author.id)
          }
          if (ts < monthStart) { msgs.clear(); break }
        }
        lastId = msgs.last()?.id
        if (!lastId) break
        await new Promise(r => setTimeout(r, 500))
      }

      if (channel.threads) {
        // Active threads
        const active = await channel.threads.fetchActive()
        for (const thread of active.threads.values()) {
          let threadLastId = null
          while (true) {
            const msgs = await thread.messages.fetch({ limit: 100, before: threadLastId })
            if (!msgs.size) break
            for (const msg of msgs.values()) {
              const ts = msg.createdAt
              if (ts >= monthStart && ts < monthEnd) {
                totalMessages++
                if (!msg.author.bot) uniquePostersSet.add(msg.author.id)
              }
              if (ts < monthStart) { msgs.clear(); break }
            }
            threadLastId = msgs.last()?.id
            if (!threadLastId) break
            await new Promise(r => setTimeout(r, 500))
          }
        }
        // Archived threads
        const archived = await channel.threads.fetchArchived({ limit: 100 })
        for (const thread of archived.threads.values()) {
          let threadLastId = null
          while (true) {
            const msgs = await thread.messages.fetch({ limit: 100, before: threadLastId })
            if (!msgs.size) break
            for (const msg of msgs.values()) {
              const ts = msg.createdAt
              if (ts >= monthStart && ts < monthEnd) {
                totalMessages++
                if (!msg.author.bot) uniquePostersSet.add(msg.author.id)
              }
              if (ts < monthStart) { msgs.clear(); break }
            }
            threadLastId = msgs.last()?.id
            if (!threadLastId) break
            await new Promise(r => setTimeout(r, 500))
          }
        }
      }
    }

    data[key] = {
      memberCount,
      totalMessages,
      uniquePosters: uniquePostersSet.size
    }
    console.log(`📊 Wrote stats for ${key}: ${totalMessages} msgs, ${uniquePostersSet.size} uniquePosters, ${memberCount} members`)
  }

  // Sort and write out
  const ordered = {}
  Object.keys(data).sort().forEach(k => { ordered[k] = data[k] })
  const outDir = path.dirname(OUTPUT_FILE)
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(ordered, null, 2))
  console.log(`✅ Stats written to ${OUTPUT_FILE}`)
  process.exit(0)
})

client.login(DISCORD_TOKEN)
