require('dotenv').config();
const express = require('express');
const {
    Client, GatewayIntentBits, EmbedBuilder,
    PermissionFlagsBits, ChannelType,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder
} = require('discord.js');

const app = express();
app.use(express.json());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ]
});

// ── CONFIG ─────────────────────────────────────────────
const CATEGORY_ID    = '1413931822756266134';
const STAFF_ROLE_ID  = '1474007983662039278';
const LOG_CHANNEL_ID = '1474008805879713799';
const FOOTER_TEXT    = "Tom's Totally Legitimate Rental Service";
// ───────────────────────────────────────────────────────

// Health checks
app.get('/',       (req, res) => res.status(200).send("Tom's Rental Bot is running!"));
app.get('/health', (req, res) => res.status(200).json({
    status: 'ok',
    bot: client.isReady() ? 'connected' : 'disconnected'
}));

// ── NEW ORDER ──────────────────────────────────────────
app.post('/new-order', async (req, res) => {
    const data = req.body;
    const guild = client.guilds.cache.first();
    if (!guild) return res.status(500).send('Bot not in any server');

    try {
        const ticketId = Math.floor(1000 + Math.random() * 9000);
        const sanitizedUser = (data.discord || 'unknown')
            .toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15);

        // Shared footer with today's date for every embed
        const now = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const footer = { text: `${now}  •  ${FOOTER_TEXT}` };

        // Try to find the renter in the server
        let renter = null;
        try {
            const members = await guild.members.fetch({ query: data.discord, limit: 1 });
            renter = members.first();
        } catch { console.log('Renter not found in server.'); }

        // Channel permissions
        const overwrites = [
            { id: guild.id,      deny:  [PermissionFlagsBits.ViewChannel] },
            { id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
        ];
        if (renter) {
            overwrites.push({
                id: renter.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]
            });
        }

        const channel = await guild.channels.create({
            name: `rental-${sanitizedUser}-${ticketId}`,
            parent: CATEGORY_ID,
            type: ChannelType.GuildText,
            permissionOverwrites: overwrites,
        });

        // ── GREETING ──
        await channel.send({
            content: renter
                ? `Hello <@${renter.id}>, thank you for renting! <@&${STAFF_ROLE_ID}>`
                : `Hello **${data.discord}**, thank you for renting! <@&${STAFF_ROLE_ID}> *(renter not found in server)*`
        });

        // ── RENTER INFO EMBED ──
        const promoCode      = (data.promoCodes || 'None').trim();
        const promoDisplay   = (promoCode && promoCode.toLowerCase() !== 'none') ? promoCode : 'None';
        const locationDisplay = (data.airport && data.airport !== 'N/A') ? data.airport : 'N/A';

        const infoEmbed = new EmbedBuilder()
            .setColor(0x1d4a6b)
            .setTitle('⚓ Rental Details')
            .addFields(
                { name: 'Discord Username', value: data.discord  || 'N/A', inline: false },
                { name: 'Roblox Username',  value: data.roblox   || 'N/A', inline: false },
                { name: 'Timezone',         value: data.timezone || 'N/A', inline: false },
                { name: 'Pick-Up Location', value: locationDisplay,        inline: false },
                { name: 'Promo Code',       value: promoDisplay,           inline: false }
            )
            .setFooter(footer);

        await channel.send({ embeds: [infoEmbed] });

        // ── PER-VEHICLE EMBEDS ──
        // Manifest format: "Ship Name | Duration;;;Ship Name | Duration"
        if (data.manifest) {
            const items = data.manifest.split(';;;');
            for (const item of items) {
                if (item.trim().length < 3) continue;
                const parts = item.split('|').map(p => p.trim());
                const vehicleName = parts[0] || 'Unknown';
                const duration    = parts[1] || 'N/A';

                const rentalEmbed = new EmbedBuilder()
                    .setColor(0x1d4a6b)
                    .setTitle(`🚢 ${vehicleName}`)
                    .addFields(
                        { name: 'Ship Name', value: vehicleName, inline: false },
                        { name: 'Duration',  value: duration,    inline: false }
                    )
                    .setFooter(footer);

                await channel.send({ embeds: [rentalEmbed] });
            }
        }

        // ── TOTAL + BUTTONS ──
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('claim').setLabel('Claim Rental').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
        );

        await channel.send({
            content: `Total Due: ${data.amount}`,
            components: [row]
        });

        res.status(200).send('OK');
    } catch (e) {
        console.error('Rental creation error:', e);
        res.status(500).send('Error');
    }
});

// ── BUTTON INTERACTIONS ────────────────────────────────
client.on('interactionCreate', async i => {
    if (!i.isButton()) return;
    if (!i.member.roles.cache.has(STAFF_ROLE_ID)) {
        return i.reply({ content: '❌ Staff only.', ephemeral: true });
    }

    if (i.customId === 'claim') {
        const priceLine = i.message.content.split('\n')[0];
        const claimedRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('claimed_status')
                .setLabel(`Claimed by ${i.user.username}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId('close')
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Danger)
        );
        await i.channel.setName(`claimed-${i.channel.name}`);
        await i.update({
            content: `${priceLine}\n✅ Being handled by ${i.user}!`,
            components: [claimedRow]
        });
    }

    if (i.customId === 'close') {
        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_delete')
                .setLabel('Confirm Close')
                .setStyle(ButtonStyle.Danger)
        );
        await i.reply({
            content: '⚠️ Close this rental ticket and save transcript to logs?',
            components: [confirmRow],
            ephemeral: true
        });
    }

    if (i.customId === 'confirm_delete') {
        const messages = await i.channel.messages.fetch({ limit: 100 });
        let transcript = `RENTAL TRANSCRIPT: ${i.channel.name}\n${'─'.repeat(50)}\n\n`;
        messages.reverse().forEach(m => {
            transcript += `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content}\n`;
        });

        const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (logChannel) {
            const file = new AttachmentBuilder(
                Buffer.from(transcript, 'utf-8'),
                { name: `transcript-${i.channel.name}.txt` }
            );
            await logChannel.send({
                content: `📑 **Rental Closed:** ${i.channel.name}`,
                files: [file]
            });
        }
        await i.channel.delete();
    }
});

// ── BOT EVENTS ─────────────────────────────────────────
client.on('error', err => console.error('Discord client error:', err));
client.once('ready', () => {
    console.log(`✅ Bot Online: ${client.user.tag}`);
    console.log(`📊 Servers: ${client.guilds.cache.size}`);
});

// ── START ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server listening on port ${PORT}`);
    client.login(process.env.DISCORD_TOKEN)
        .then(() => console.log('🤖 Discord login initiated'))
        .catch(err => { console.error('❌ Discord login failed:', err); process.exit(1); });
});
