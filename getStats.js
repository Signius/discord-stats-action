#!/usr/bin/env node
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

  console.log(`🔄 Fetching all guild channels...`)
  await guild.channels.fetch()
  console.log(`✅ Guild channels loaded`)

  const botMember = await guild.members.fetch(client.user.id)
  const hasGuildViewPermission = botMember.permissions.has(PermissionsBitField.Flags.ViewChannel)
  console.log(`👁️  Bot has guild-level ViewChannel permission: ${hasGuildViewPermission}`)

  const allChannels = Array.from(guild.channels.cache.values())
  const allTextChannels = allChannels.filter(c => c.isTextBased())

  const forumChannels = allChannels.filter(c => c.type === ChannelType.GuildForum)
  const forumPosts = []

  for (const forum of forumChannels) {
    try {
      console.log(`→ Fetching posts from forum: ${forum.name}`)

      const botPermissionsInForum = forum.permissionsFor(botMember)
      if (!botPermissionsInForum?.has(PermissionsBitField.Flags.ViewChannel)) {
        console.log(`  ❌ Bot cannot view forum ${forum.name}`)
        continue
      }

      const posts = await forum.threads.fetchActive()
      const archivedPosts = await forum.threads.fetchArchived()

      for (const [id, post] of new Map([...posts.threads, ...archivedPosts.threads])) {
        if (!forumPosts.find(p => p.id === post.id)) {
          forumPosts.push(post)
        }
      }
    } catch (err) {
      console.warn(`⚠️ Skipping forum ${forum.name} due to error: ${err.message || err}`)
    }
  }

  const allTextChannelsWithPosts = [...allTextChannels, ...forumPosts]

  const accessibleChannels = []
  for (const channel of allTextChannelsWithPosts) {
    try {
      await channel.messages.fetch({ limit: 1 })
      accessibleChannels.push(channel)
    } catch (err) {
      console.warn(`⚠️ Skipping channel ${channel.name} due to access error: ${err.message}`)
    }
  }

  const channels = accessibleChannels

  let data = {}
  if (fs.existsSync(OUTPUT_FILE)) {
    data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
  }

  const now = new Date()

  // BACKFILL and monthly processing logic reused from original script
  // Place your original processing logic blocks (for BACKFILL and !BACKFILL) here

  // End - Write output
  const ordered = {}
  Object.keys(data).sort().forEach(k => { ordered[k] = data[k] })
  const outDir = path.dirname(OUTPUT_FILE)
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(ordered, null, 2))
  console.log(`✅ Stats written to ${OUTPUT_FILE}`)
  process.exit(0)
})

client.login(DISCORD_TOKEN)
