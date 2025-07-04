//!/usr/bin/env node
import { Client, GatewayIntentBits, ChannelType, PermissionsBitField } from 'discord.js'
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

function getChannelTypeName(type) {
  switch (type) {
    case ChannelType.GuildText: return 'Text Channel'
    case ChannelType.GuildAnnouncement: return 'Announcement Channel'
    case ChannelType.GuildForum: return 'Forum Channel'
    case ChannelType.GuildMedia: return 'Media Channel'
    case ChannelType.GuildStageVoice: return 'Stage Channel'
    case ChannelType.GuildVoice: return 'Voice Channel'
    case ChannelType.GuildDirectory: return 'Directory Channel'
    case ChannelType.GuildCategory: return 'Category'
    default: return `Unknown Type (${type})`
  }
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

  // Ensure all channels are fetched
  console.log(`🔄 Fetching all guild channels...`)
  await guild.channels.fetch()
  console.log(`✅ Guild channels loaded`)

  const botMember = await guild.members.fetch(client.user.id)
  const hasGuildViewPermission = botMember.permissions.has(PermissionsBitField.Flags.ViewChannel)
  console.log(`👁️  Bot has guild-level ViewChannel permission: ${hasGuildViewPermission}`)

  const allChannels = Array.from(guild.channels.cache.values())
  const allTextChannels = Array.from(guild.channels.cache.filter(c => c.isTextBased()).values())
  const forumChannels = allChannels.filter(c => c.type === ChannelType.GuildForum)
  console.log(`🔍 Found ${forumChannels.length} forum channels`)

  const forumPosts = []
  for (const forum of forumChannels) {
    try {
      const posts = await forum.threads.fetchActive()
      const archived = await forum.threads.fetchArchived()
      for (const [id, post] of [...posts.threads, ...archived.threads]) {
        forumPosts.push(post)
      }
    } catch (err) {
      console.log(`❌ Forum fetch failed: ${err.message}`)
    }
  }

  const allTextChannelsWithPosts = [...allTextChannels, ...forumPosts]

  console.log(`
🧪 Testing channel access...`)
  const accessibleChannels = []
  const inaccessibleChannels = []

  for (const channel of allTextChannelsWithPosts) {
    try {
      await channel.messages.fetch({ limit: 1 })
      accessibleChannels.push(channel)
      console.log(`  ✅ ${channel.name} - Accessible`)
    } catch (err) {
      inaccessibleChannels.push(channel)
      console.log(`  ❌ ${channel.name} - Inaccessible: ${err.message}`)
    }
  }

  const channels = accessibleChannels

  let data = {}
  if (fs.existsSync(OUTPUT_FILE)) {
    data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
  }

  console.log(`📊 ${channels.length} accessible channels will be processed.`)
  const now = new Date()

  const buckets = {}
  const processMessages = async (msgs, startDate, endDate) => {
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
  }

  const processChannel = async (channel, startDate, endDate) => {
    console.log(`📝 Processing channel: ${channel.name}`)
    let lastId = null
    while (true) {
      try {
        const msgs = await channel.messages.fetch({ limit: 100, before: lastId })
        if (!msgs.size) break
        await processMessages(msgs, startDate, endDate)
        lastId = msgs.last()?.id
        if (!lastId) break
        await new Promise(r => setTimeout(r, 500))
      } catch (e) {
        console.warn(`⚠️ Skipping channel ${channel.id} due to error: ${e.message}`)
        break
      }
    }
  }

  const startDate = BACKFILL ? new Date(BACKFILL_YEAR, 0, 1) : new Date(now.getFullYear(), now.getMonth()-1, 1)
  const endDate = BACKFILL ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getFullYear(), now.getMonth(), 1)
  const targetKey = `${startDate.getFullYear()}-${String(startDate.getMonth()+1).padStart(2,'0')}`

  for (const channel of channels) {
    await processChannel(channel, startDate, endDate)
    if (channel.threads) {
      try {
        const threadGroups = [await channel.threads.fetchActive(), await channel.threads.fetchArchived({ limit: 100 })]
        for (const group of threadGroups) {
          for (const thread of group.threads.values()) {
            await processChannel(thread, startDate, endDate)
          }
        }
      } catch (e) {
        console.warn(`⚠️ Skipping threads for ${channel.name} due to: ${e.message}`)
      }
    }
  }

  if (BACKFILL) {
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
    const stats = buckets[targetKey] || { totalMessages: 0, uniquePosters: new Set() }
    data[targetKey] = {
      memberCount,
      totalMessages: stats.totalMessages,
      uniquePosters: stats.uniquePosters.size
    }
    console.log(`📊 Wrote stats for ${targetKey}: ${stats.totalMessages} msgs, ${stats.uniquePosters.size} uniquePosters, ${memberCount} members`)
  }

  const ordered = {}
  Object.keys(data).sort().forEach(k => { ordered[k] = data[k] })
  const outDir = path.dirname(OUTPUT_FILE)
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(ordered, null, 2))
  console.log(`✅ Stats written to ${OUTPUT_FILE}`)
  process.exit(0)
})

client.login(DISCORD_TOKEN)
