require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');

const app = express();
app.use(express.json());

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent] 
});

const CATEGORY_ID = '1375884023145955511';
const STAFF_ROLE_ID = '1345648632342249564'; 
const LOG_CHANNEL_ID = '1345510649760846056';

// Health check endpoint for Zeabur
app.get('/', (req, res) => {
    res.status(200).send('Bot is running!');
});

app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        bot: client.isReady() ? 'connected' : 'disconnected' 
    });
});

app.post('/new-order', async (req, res) => {
    const data = req.body;
    const guild = client.guilds.cache.first(); 
    if (!guild) return res.status(500).send('Bot error');

    try {
        // 1. Generate a unique name suffix to prevent duplicates
        const ticketId = Math.floor(1000 + Math.random() * 9000);
        const sanitizedUser = (data.discord || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15);
        
        // 2. Try to find the user in the server to give them access
        let targetUser = null;
        try {
            // Search by ID first (if they provided one) or by username query
            const members = await guild.members.fetch({ query: data.discord, limit: 1 });
            targetUser = members.first();
        } catch (err) { console.log("User not found in server yet."); }

        // 3. Setup Permissions
        const overwrites = [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, // Hide from everyone
            { id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] } // Show to staff
        ];

        // If we found the user, add them to the channel permissions
        if (targetUser) {
            overwrites.push({
                id: targetUser.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]
            });
        }

        const newChannel = await guild.channels.create({
            name: `ticket-${sanitizedUser}-${ticketId}`,
            parent: CATEGORY_ID,
            type: ChannelType.GuildText,
            permissionOverwrites: overwrites,
        });

// 4. Header Embed - UPDATED TO HANDLE BUNDLED PROMO (CODE|VISIBILITY)
        const headerFields = [
            { name: 'Roblox Username', value: data.roblox || "N/A", inline: true },
            { name: 'Timezone', value: data.timezone || "N/A", inline: true }
        ];
        
        // Split the bundled promo data
        // Format expected: "CODE|SHOW" or "CODE|HIDE"
        const rawPromoData = data.promoCodes || "None|SHOW";
        const [promoCode, visibility] = rawPromoData.split('|');
        
        // Only add promo code field if:
        // 1. It is NOT hidden
        // 2. It is NOT "None"
        if (visibility !== 'HIDE' && promoCode && promoCode.toLowerCase() !== 'none') {
            headerFields.push({ name: 'Promo Code', value: promoCode, inline: true });
        }
        
        // Add airport field if provided
        if (data.airport && data.airport !== 'N/A') {
            headerFields.push({ name: 'Pick Up Location', value: data.airport, inline: false });
        }
        
        const header = new EmbedBuilder()
            .setColor(0x0E1C59)
            .setTitle(`✈️ New Order Request`)
            .setDescription(`**Customer:** ${targetUser ? `<@${targetUser.id}>` : data.discord}`)
            .addFields(headerFields)
            .setFooter({ text: `Ticket ID: ${ticketId}` });

        await newChannel.send({ 
            content: targetUser ? `Welcome <@${targetUser.id}>! <@&${STAFF_ROLE_ID}>` : `<@&${STAFF_ROLE_ID}> (User not found in server)`, 
            embeds: [header] 
        });

        // 5. Aircraft Details - NOW HANDLES CUSTOMS PROPERLY
        if (data.manifest && data.manifest.includes('|')) {
            const items = data.manifest.split(';;;');
            for (let item of items) {
                if (item.trim().length < 5) continue;
                const parts = item.split('|');
                const name = parts[0] || 'Unknown';
                const qty = parts[1] || '1';
                const cond = parts[2] || 'New';
                const livery = parts[3] || 'L: Standard';
                const customs = parts[4] || 'C: Standard';
                const notes = parts[5] || 'Notes: None';
                
                // Clean up the prefixes
                const cleanLivery = livery.replace('L: ', '');
                const cleanCustoms = customs.replace('C: ', '');
                const cleanNotes = notes.replace('Notes: ', '');
                
                const fields = [
                    { name: 'Qty', value: qty, inline: true },
                    { name: 'Condition', value: cond, inline: true },
                    { name: 'Livery', value: cleanLivery, inline: false }
                ];
                
                // Only add customization field if not "Standard"
                if (cleanCustoms !== 'Standard') {
                    fields.push({ name: 'Customization', value: cleanCustoms, inline: false });
                }
                
                // Only add notes field if not "None"
                if (cleanNotes !== 'None') {
                    fields.push({ name: 'Notes', value: cleanNotes, inline: false });
                }
                
                const acEmbed = new EmbedBuilder()
                    .setColor(0x0E1C59)
                    .setTitle(`Aircraft: ${name}`)
                    .addFields(fields);
                    
                await newChannel.send({ embeds: [acEmbed] });
            }
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('claim').setLabel('Claim Order').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
        );

        await newChannel.send({ 
            content: `### Total Due: ${data.amount}\nOur staff will be with you shortly.`, 
            components: [row] 
        });

        res.status(200).send('OK');
    } catch (e) { 
        console.error('Order creation error:', e); 
        res.status(500).send('Error'); 
    }
});

// --- INTERACTION LOGIC ---
client.on('interactionCreate', async i => {
    if (!i.isButton()) return;
    if (!i.member.roles.cache.has(STAFF_ROLE_ID)) return i.reply({ content: "❌ Staff only.", ephemeral: true });

    if (i.customId === 'claim') {
        const originalPriceLine = i.message.content.split('\n')[0]; 
        const claimedRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('claimed_status').setLabel(`Claimed by ${i.user.username}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
        );
        await i.channel.setName(`claimed-${i.channel.name}`);
        await i.update({ content: `${originalPriceLine}\n✅ This order is being handled by ${i.user}!`, components: [claimedRow] });
    }

    if (i.customId === 'close') {
        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirm_delete').setLabel('Confirm Close').setStyle(ButtonStyle.Danger)
        );
        await i.reply({ content: "⚠️ Close ticket and save transcript to logs?", components: [confirmRow], ephemeral: true });
    }

    if (i.customId === 'confirm_delete') {
        const messages = await i.channel.messages.fetch({ limit: 100 });
        let transcript = `TRANSCRIPT FOR: ${i.channel.name}\n\n`;
        messages.reverse().forEach(m => {
            transcript += `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content}\n`;
        });
        
        const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (logChannel) {
            const attachment = new AttachmentBuilder(Buffer.from(transcript, 'utf-8'), { name: `transcript-${i.channel.name}.txt` });
            await logChannel.send({ content: `📑 **Ticket Closed:** ${i.channel.name}`, files: [attachment] });
        }
        await i.channel.delete();
    }
});

// Discord bot error handling
client.on('error', error => {
    console.error('Discord client error:', error);
});

client.once('ready', () => {
    console.log(`✅ Bot Online: ${client.user.tag}`);
    console.log(`📊 Servers: ${client.guilds.cache.size}`);
});

// Start Express server first
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server listening on port ${PORT}`);
    
    // Then connect Discord bot
    client.login(process.env.DISCORD_TOKEN)
        .then(() => console.log('🤖 Discord login initiated'))
        .catch(err => {
            console.error('❌ Discord login failed:', err);
            process.exit(1);
        });
});
