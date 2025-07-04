#!/usr/bin/env node
// getStats.js
import { Client, GatewayIntentBits, ChannelType, PermissionsBitField } from 'discord.js'
import fs from 'fs'
import path from 'path'
import { getConfig, getRepoRoot } from '../org-stats/config-loader.js'

// Helper function to get readable channel type names
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
    console.error('❌ DISCORD_TOKEN must be set and discordGuildId must be configured in org-stats-config.json')
    process.exit(1)
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages      // if you later want per-month memberCount
    ]
})

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`)
    const guild = await client.guilds.fetch(GUILD_ID)
    const memberCount = guild.memberCount

    // Ensure we have all channels loaded
    console.log(`🔄 Fetching all guild channels...`)
    await guild.channels.fetch()
    console.log(`✅ Guild channels loaded`)

    // Get bot member to check permissions
    const botMember = await guild.members.fetch(client.user.id)

    // Check if we have ViewChannel permission at guild level
    const hasGuildViewPermission = botMember.permissions.has(PermissionsBitField.Flags.ViewChannel)
    console.log(`👁️  Bot has guild-level ViewChannel permission: ${hasGuildViewPermission}`)

    const allChannels = Array.from(guild.channels.cache.values())
    const allTextChannels = Array.from(guild.channels.cache.filter(c => c.isTextBased()).values())

    // Get forum channels and fetch their posts
    const forumChannels = allChannels.filter(c => c.type === ChannelType.GuildForum) // Forum Channel type
    console.log(`\n🔍 Found ${forumChannels.length} forum channels`)

    const forumPosts = []
    for (const forum of forumChannels) {
        try {
            console.log(`  → Fetching posts from forum: ${forum.name}`)

            // Check bot's permissions for this specific forum
            const botPermissionsInForum = forum.permissionsFor(botMember)
            const canViewForum = botPermissionsInForum?.has(PermissionsBitField.Flags.ViewChannel)
            const canReadHistory = botPermissionsInForum?.has(PermissionsBitField.Flags.ReadMessageHistory)

            console.log(`    🔑 Bot permissions in ${forum.name}:`)
            console.log(`      - ViewChannel: ${canViewForum ? '✅' : '❌'}`)
            console.log(`      - ReadMessageHistory: ${canReadHistory ? '✅' : '❌'}`)

            if (!canViewForum) {
                console.log(`    ❌ Bot cannot view forum ${forum.name} - missing ViewChannel permission`)
                continue
            }

            const posts = await forum.threads.fetchActive()
            console.log(`    ✅ Found ${posts.threads.size} active posts`)

            // Also fetch archived posts
            const archivedPosts = await forum.threads.fetchArchived()
            console.log(`    ✅ Found ${archivedPosts.threads.size} archived posts`)

            // Combine all posts
            const allPosts = new Map([...posts.threads, ...archivedPosts.threads])
            console.log(`    📊 Total posts in ${forum.name}: ${allPosts.size}`)

            // Add posts to our collection (avoiding duplicates)
            for (const [id, post] of allPosts) {
                if (!forumPosts.find(p => p.id === post.id)) {
                    forumPosts.push(post)
                }
            }
        } catch (err) {
            console.log(`    ❌ Failed to fetch posts from forum ${forum.name}: ${err.message || err}`)

            // Try to get more specific error information
            if (err.message && err.message.includes('Missing Access')) {
                console.log(`    💡 This forum is likely private. To access it:`)
                console.log(`      1. Make sure the bot has a role with ViewChannel permission`)
                console.log(`      2. Check if the forum has role-based permissions that exclude the bot`)
                console.log(`      3. Verify the bot's role is above the @everyone role in the server`)
            }
        }
    }

    console.log(`📊 Total forum posts found: ${forumPosts.length}`)

    // Combine regular text channels with forum posts
    const allTextChannelsWithPosts = [...allTextChannels, ...forumPosts]

    // Test access to each channel to see if we can actually fetch messages
    console.log(`\n🧪 Testing channel access...`)
    const accessibleChannels = []
    const inaccessibleChannels = []

    for (const channel of allTextChannelsWithPosts) {
        try {
            // Try to fetch a single message to test access
            await channel.messages.fetch({ limit: 1 })
            accessibleChannels.push(channel)
            console.log(`  ✅ ${channel.name} - Accessible`)
        } catch (err) {
            inaccessibleChannels.push(channel)
            const errorMsg = err?.message || 'Unknown error'
            console.log(`  ❌ ${channel.name} - Inaccessible: ${errorMsg}`)
        }
    }

    console.log(`\n📊 Channel access summary:`)
    console.log(`  ✅ Accessible channels: ${accessibleChannels.length}`)
    console.log(`  ❌ Inaccessible channels: ${inaccessibleChannels.length}`)

    // Use the accessible channels for processing
    const channels = accessibleChannels

    // collect or load existing stats
    let data = {}
    if (fs.existsSync(OUTPUT_FILE)) {
        data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
    }

    console.log(`🔍 Total channels in guild: ${guild.channels.cache.size}`)
    console.log(`🔍 Text-based channels: ${allTextChannels.length}`)
    console.log(`🔍 Forum posts: ${forumPosts.length}`)
    console.log(`🔍 Total text channels + forum posts: ${allTextChannelsWithPosts.length}`)
    console.log(`🔍 Viewable text channels: ${channels.length}`)
    console.log(`🔍 Missing channels: ${allTextChannelsWithPosts.length - channels.length}`)

    // Show all channels to see what we're missing
    console.log(`\n📋 ALL channels in guild:`)
    allChannels.forEach((channel, index) => {
        const isTextBased = channel.isTextBased()
        const typeName = getChannelTypeName(channel.type)
        console.log(`  ${index + 1}. ${channel.name} (${channel.id}) - Type: ${channel.type} (${typeName}) - Text-based: ${isTextBased ? 'Yes' : 'No'}`)
    })

    // Log all text channels and their accessibility with more details
    console.log(`📋 All text channels and their status:`)
    allTextChannelsWithPosts.forEach((channel, index) => {
        const isAccessible = accessibleChannels.includes(channel)
        const status = isAccessible ? '✅ Accessible' : '❌ No Access'
        const channelType = channel.type === 11 ? 'Forum Post' : getChannelTypeName(channel.type)
        console.log(`  ${index + 1}. ${channel.name} (${channel.id}) - Type: ${channel.type} (${channelType}) - ${status}`)
    })

    console.log(`\n📋 Channels to process:`)
    channels.forEach((channel, index) => {
        console.log(`  ${index + 1}. ${channel.name} (${channel.id}) - Type: ${channel.type}`)
    })

    // Analyze missing channels by type with more details
    const missingChannels = inaccessibleChannels

    const missingByType = {}
    missingChannels.forEach(channel => {
        const typeName = getChannelTypeName(channel.type)
        if (!missingByType[typeName]) {
            missingByType[typeName] = { count: 0, channels: [] }
        }
        missingByType[typeName].count++
        missingByType[typeName].channels.push(channel.name)
    })

    if (Object.keys(missingByType).length > 0) {
        console.log(`\n❌ Missing channels by type:`)
        Object.entries(missingByType).forEach(([type, info]) => {
            console.log(`  ${type}: ${info.count} channels`)
            info.channels.forEach(channelName => {
                console.log(`    - ${channelName}`)
            })
        })
    }

    // Also log channels that might be private but not caught by the filter
    const potentiallyPrivateChannels = accessibleChannels.filter(c => {
        // Check if channel has permission overwrites (might indicate private channel)
        const hasOverwrites = 'permissionOverwrites' in c && c.permissionOverwrites && c.permissionOverwrites.cache.size > 0
        return hasOverwrites
    })

    if (potentiallyPrivateChannels.length > 0) {
        console.log(`\n🔒 Potentially private channels (have permission overwrites):`)
        potentiallyPrivateChannels.forEach((channel, index) => {
            console.log(`  ${index + 1}. ${channel.name} (${channel.id}) - Type: ${channel.type}`)
        })
    }

    const now = new Date()

    if (BACKFILL) {
        console.log('🔄 Backfilling Jan → last full month of', BACKFILL_YEAR)

        /** map YYYY-MM → { totalMessages, uniquePosters:Set<userId> } **/
        const buckets = {}
        const startDate = new Date(BACKFILL_YEAR, 0, 1)      // Jan 1, BACKFILL_YEAR
        const endDate = new Date(now.getFullYear(), now.getMonth(), 1)  // 1st of current month

        console.log(`📅 Processing period: ${startDate.toISOString()} → ${endDate.toISOString()}`)
        console.log(`📊 Found ${channels.length} channels to process`)

        for (const channel of channels) {
            console.log(`\n📝 Processing channel: ${channel.name} (${channel.id})`)

            // — process the main channel —
            let lastId = null
            let messageCount = 0
            try {
                console.log(`  → Fetching main channel messages...`)
                let fetchCount = 0
                outer: while (true) {
                    const msgs = await channel.messages.fetch({ limit: 100, before: lastId })
                    if (msgs.size === 0) break
                    fetchCount++

                    for (const msg of msgs.values()) {
                        const ts = msg.createdAt
                        if (ts < startDate) break outer
                        if (ts < endDate) {
                            const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`
                            if (!buckets[key]) buckets[key] = { totalMessages: 0, uniquePosters: new Set() }
                            buckets[key].totalMessages++
                            if (!msg.author.bot) buckets[key].uniquePosters.add(msg.author.id)
                            messageCount++
                        }
                    }

                    lastId = msgs.last()?.id
                    if (!lastId) break
                    await new Promise(r => setTimeout(r, 500))
                }
                console.log(`    → Fetched ${fetchCount} batches of messages`)
                console.log(`  ✅ Main channel: processed ${messageCount} messages`)
            } catch (err) {
                if (err.message && err.message.includes('Missing Access')) {
                    console.warn(`⚠️  Skipping channel ${channel.name} - Missing Access (likely private channel)`)
                } else {
                    console.error(`❌ Failed to process main channel ${channel.name}: ${err.message || err}`)
                }
                continue
            }

            // — now include all thread messages for that channel —
            if (channel.threads) {
                console.log(`  → Processing threads for channel ${channel.name}...`)

                // active threads with pagination
                let active = { threads: new Map() }
                try {
                    console.log(`    → Fetching active threads with pagination...`)
                    let before = null
                    let totalActiveThreads = 0
                    let fetchCount = 0

                    while (true) {
                        fetchCount++
                        const options = { limit: 100 }
                        if (before) options.before = before

                        const activeBatch = await channel.threads.fetchActive(options)
                        console.log(`      → Batch ${fetchCount}: fetched ${activeBatch.threads.size} active threads`)

                        if (activeBatch.threads.size === 0) break

                        // Merge threads into our collection
                        for (const [id, thread] of activeBatch.threads) {
                            active.threads.set(id, thread)
                        }

                        totalActiveThreads = active.threads.size
                        before = activeBatch.threads.last()?.id

                        if (!before) break

                        // Rate limiting
                        await new Promise(r => setTimeout(r, 1000))
                    }

                    console.log(`    ✅ Found ${totalActiveThreads} total active threads (${fetchCount} batches)`)
                } catch (err) {
                    if (err.message && err.message.includes('Missing Access')) {
                        console.warn(`⚠️  Skipping active threads in channel ${channel.name} - Missing Access`)
                    } else {
                        console.error(`❌ Failed to fetch active threads in channel ${channel.name}: ${err.message || err}`)
                    }
                }

                for (const thread of active.threads.values()) {
                    console.log(`    → Processing active thread: ${thread.name} (${thread.id})`)
                    let threadLastId = null
                    let threadMessageCount = 0
                    try {
                        while (true) {
                            const msgs = await thread.messages.fetch({ limit: 100, before: threadLastId })
                            if (msgs.size === 0) break
                            for (const msg of msgs.values()) {
                                const ts = msg.createdAt
                                if (ts < startDate) break
                                if (ts < endDate) {
                                    const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`
                                    if (!buckets[key]) buckets[key] = { totalMessages: 0, uniquePosters: new Set() }
                                    buckets[key].totalMessages++
                                    if (!msg.author.bot) buckets[key].uniquePosters.add(msg.author.id)
                                    threadMessageCount++
                                }
                            }
                            threadLastId = msgs.last()?.id
                            if (!threadLastId) break
                            await new Promise(r => setTimeout(r, 500))
                        }
                        console.log(`      ✅ Active thread ${thread.name}: processed ${threadMessageCount} messages`)
                    } catch (err) {
                        console.error(`❌ Failed to process active thread ${thread.name} in channel ${channel.name}: ${err.message || err}`)
                        continue
                    }
                }
                // archived threads with pagination
                let archived = { threads: new Map() }
                try {
                    console.log(`    → Fetching archived threads with pagination...`)
                    let before = null
                    let totalArchivedThreads = 0
                    let fetchCount = 0

                    while (true) {
                        fetchCount++
                        const options = { limit: 100 }
                        if (before) options.before = before

                        const archivedBatch = await channel.threads.fetchArchived(options)
                        console.log(`      → Batch ${fetchCount}: fetched ${archivedBatch.threads.size} archived threads`)

                        if (archivedBatch.threads.size === 0) break

                        // Merge threads into our collection
                        for (const [id, thread] of archivedBatch.threads) {
                            archived.threads.set(id, thread)
                        }

                        totalArchivedThreads = archived.threads.size
                        before = archivedBatch.threads.last()?.id

                        if (!before) break

                        // Rate limiting
                        await new Promise(r => setTimeout(r, 1000))
                    }

                    console.log(`    ✅ Found ${totalArchivedThreads} total archived threads (${fetchCount} batches)`)
                } catch (err) {
                    if (err.message && err.message.includes('Missing Access')) {
                        console.warn(`⚠️  Skipping archived threads in channel ${channel.name} - Missing Access`)
                    } else {
                        console.error(`❌ Failed to fetch archived threads in channel ${channel.name}: ${err.message || err}`)
                    }
                }

                for (const thread of archived.threads.values()) {
                    console.log(`    → Processing archived thread: ${thread.name} (${thread.id})`)
                    let threadLastId = null
                    let threadMessageCount = 0
                    try {
                        while (true) {
                            const msgs = await thread.messages.fetch({ limit: 100, before: threadLastId })
                            if (msgs.size === 0) break
                            for (const msg of msgs.values()) {
                                const ts = msg.createdAt
                                if (ts < startDate) break
                                if (ts < endDate) {
                                    const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`
                                    if (!buckets[key]) buckets[key] = { totalMessages: 0, uniquePosters: new Set() }
                                    buckets[key].totalMessages++
                                    if (!msg.author.bot) buckets[key].uniquePosters.add(msg.author.id)
                                    threadMessageCount++
                                }
                            }
                            threadLastId = msgs.last()?.id
                            if (!threadLastId) break
                            await new Promise(r => setTimeout(r, 500))
                        }
                        console.log(`      ✅ Archived thread ${thread.name}: processed ${threadMessageCount} messages`)
                    } catch (err) {
                        console.error(`❌ Failed to process archived thread ${thread.name} in channel ${channel.name}: ${err.message || err}`)
                        continue
                    }
                }
            }
        }

        console.log(`\n📊 Processing results...`)
        // populate data object per month
        for (let m = 0; m < now.getMonth(); m++) {
            const dt = new Date(BACKFILL_YEAR, m, 1)
            const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
            const monthStats = buckets[key] || { totalMessages: 0, uniquePosters: new Set() }
            data[key] = {
                memberCount,
                totalMessages: monthStats.totalMessages,
                uniquePosters: monthStats.uniquePosters.size
            }
            console.log(`  → ${key}: ${monthStats.totalMessages} msgs, ${monthStats.uniquePosters.size} uniquePosters, ${memberCount} members`)
        }

    } else {
        // — last-month only —
        const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        const monthEnd = new Date(now.getFullYear(), now.getMonth(), 1)
        const key = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`

        console.log(`📅 Processing last month: ${monthStart.toISOString()} → ${monthEnd.toISOString()}`)
        console.log(`📅 Current date: ${now.toISOString()}`)
        console.log(`📊 Found ${channels.length} channels to process`)

        let totalMessages = 0
        const uniquePostersSet = new Set()

        for (const channel of channels) {
            console.log(`\n📝 Processing channel: ${channel.name} (${channel.id})`)

            // main channel
            let lastId = null
            let messageCount = 0
            try {
                console.log(`  → Fetching main channel messages...`)
                let fetchCount = 0
                while (true) {
                    const msgs = await channel.messages.fetch({ limit: 100, before: lastId })
                    if (msgs.size === 0) break
                    fetchCount++

                    for (const msg of msgs.values()) {
                        const ts = msg.createdAt
                        if (ts >= monthStart && ts < monthEnd) {
                            totalMessages++
                            if (!msg.author.bot) uniquePostersSet.add(msg.author.id)
                            messageCount++
                        }
                        if (ts < monthStart) { msgs.clear(); break }
                    }
                    lastId = msgs.last()?.id
                    if (!lastId) break
                    await new Promise(r => setTimeout(r, 500))
                }
                console.log(`    → Fetched ${fetchCount} batches of messages`)
                console.log(`  ✅ Main channel: processed ${messageCount} messages`)
            } catch (err) {
                if (err.message && err.message.includes('Missing Access')) {
                    console.warn(`⚠️  Skipping channel ${channel.name} - Missing Access (likely private channel)`)
                } else {
                    console.error(`❌ Failed to process main channel ${channel.name}: ${err.message || err}`)
                }
                continue
            }

            // threads in channel
            if (channel.threads) {
                console.log(`  → Processing threads for channel ${channel.name}...`)

                // active threads with pagination
                let active = { threads: new Map() }
                try {
                    console.log(`    → Fetching active threads with pagination...`)
                    let before = null
                    let totalActiveThreads = 0
                    let fetchCount = 0

                    while (true) {
                        fetchCount++
                        const options = { limit: 100 }
                        if (before) options.before = before

                        const activeBatch = await channel.threads.fetchActive(options)
                        console.log(`      → Batch ${fetchCount}: fetched ${activeBatch.threads.size} active threads`)

                        if (activeBatch.threads.size === 0) break

                        // Merge threads into our collection
                        for (const [id, thread] of activeBatch.threads) {
                            active.threads.set(id, thread)
                        }

                        totalActiveThreads = active.threads.size
                        before = activeBatch.threads.last()?.id

                        if (!before) break

                        // Rate limiting
                        await new Promise(r => setTimeout(r, 1000))
                    }

                    console.log(`    ✅ Found ${totalActiveThreads} total active threads (${fetchCount} batches)`)
                } catch (err) {
                    if (err.message && err.message.includes('Missing Access')) {
                        console.warn(`⚠️  Skipping active threads in channel ${channel.name} - Missing Access`)
                    } else {
                        console.error(`❌ Failed to fetch active threads in channel ${channel.name}: ${err.message || err}`)
                    }
                }

                for (const thread of active.threads.values()) {
                    console.log(`    → Processing active thread: ${thread.name} (${thread.id})`)
                    let threadLastId = null
                    let threadMessageCount = 0
                    try {
                        while (true) {
                            const msgs = await thread.messages.fetch({ limit: 100, before: threadLastId })
                            if (msgs.size === 0) break
                            for (const msg of msgs.values()) {
                                const ts = msg.createdAt
                                if (ts >= monthStart && ts < monthEnd) {
                                    totalMessages++
                                    if (!msg.author.bot) uniquePostersSet.add(msg.author.id)
                                    threadMessageCount++
                                }
                                if (ts < monthStart) { msgs.clear(); break }
                            }
                            threadLastId = msgs.last()?.id
                            if (!threadLastId) break
                            await new Promise(r => setTimeout(r, 500))
                        }
                        console.log(`      ✅ Active thread ${thread.name}: processed ${threadMessageCount} messages`)
                    } catch (err) {
                        console.error(`❌ Failed to process active thread ${thread.name} in channel ${channel.name}: ${err.message || err}`)
                        continue
                    }
                }
                // archived threads with pagination
                let archived = { threads: new Map() }
                try {
                    console.log(`    → Fetching archived threads with pagination...`)
                    let before = null
                    let totalArchivedThreads = 0
                    let fetchCount = 0

                    while (true) {
                        fetchCount++
                        const options = { limit: 100 }
                        if (before) options.before = before

                        const archivedBatch = await channel.threads.fetchArchived(options)
                        console.log(`      → Batch ${fetchCount}: fetched ${archivedBatch.threads.size} archived threads`)

                        if (archivedBatch.threads.size === 0) break

                        // Merge threads into our collection
                        for (const [id, thread] of archivedBatch.threads) {
                            archived.threads.set(id, thread)
                        }

                        totalArchivedThreads = archived.threads.size
                        before = archivedBatch.threads.last()?.id

                        if (!before) break

                        // Rate limiting
                        await new Promise(r => setTimeout(r, 1000))
                    }

                    console.log(`    ✅ Found ${totalArchivedThreads} total archived threads (${fetchCount} batches)`)
                } catch (err) {
                    if (err.message && err.message.includes('Missing Access')) {
                        console.warn(`⚠️  Skipping archived threads in channel ${channel.name} - Missing Access`)
                    } else {
                        console.error(`❌ Failed to fetch archived threads in channel ${channel.name}: ${err.message || err}`)
                    }
                }

                for (const thread of archived.threads.values()) {
                    console.log(`    → Processing archived thread: ${thread.name} (${thread.id})`)
                    let threadLastId = null
                    let threadMessageCount = 0
                    try {
                        while (true) {
                            const msgs = await thread.messages.fetch({ limit: 100, before: threadLastId })
                            if (msgs.size === 0) break
                            for (const msg of msgs.values()) {
                                const ts = msg.createdAt
                                if (ts >= monthStart && ts < monthEnd) {
                                    totalMessages++
                                    if (!msg.author.bot) uniquePostersSet.add(msg.author.id)
                                    threadMessageCount++
                                }
                                if (ts < monthStart) { msgs.clear(); break }
                            }
                            threadLastId = msgs.last()?.id
                            if (!threadLastId) break
                            await new Promise(r => setTimeout(r, 500))
                        }
                        console.log(`      ✅ Archived thread ${thread.name}: processed ${threadMessageCount} messages`)
                    } catch (err) {
                        console.error(`❌ Failed to process archived thread ${thread.name} in channel ${channel.name}: ${err.message || err}`)
                        continue
                    }
                }
            }
        }

        data[key] = {
            memberCount,
            totalMessages,
            uniquePosters: uniquePostersSet.size
        }
        console.log(`\n📊 Final stats for ${key}: ${totalMessages} msgs, ${uniquePostersSet.size} uniquePosters, ${memberCount} members`)
    }

    // sort, write out, and exit
    console.log(`\n💾 Writing results to file...`)
    const ordered = {}
    Object.keys(data).sort().forEach(k => { ordered[k] = data[k] })
    const outDir = path.dirname(OUTPUT_FILE)
    if (!fs.existsSync(outDir)) {
        console.log(`  → Creating output directory: ${outDir}`)
        fs.mkdirSync(outDir, { recursive: true })
    }
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(ordered, null, 2))
    console.log(`✅ Stats written to ${OUTPUT_FILE}`)
    console.log(`🎉 Process completed successfully!`)
    process.exit(0)
})

client.login(DISCORD_TOKEN)
