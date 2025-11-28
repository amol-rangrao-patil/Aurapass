const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = 'cems_secret_key_999';

// --- 1. SETUP SQLITE (File Based Database) ---
// Hostinger par ye file apne aap ban jayegi
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: 'aurapass.sqlite', 
    logging: false
});

app.use(cors());
app.use(bodyParser.json());
// Serve static files (Assuming index.html is in root or public)
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. MODELS (Designed to match old MongoDB Schema) ---

const User = sequelize.define('User', {
    gid: { type: DataTypes.STRING, unique: true, allowNull: false },
    name: DataTypes.STRING,
    password: { type: DataTypes.STRING, allowNull: false },
    role: { type: DataTypes.STRING, defaultValue: 'student' },
    email: DataTypes.STRING,
    phone: DataTypes.STRING,
    // Store array as JSON string transparently
    registrations: { 
        type: DataTypes.TEXT, 
        defaultValue: '[]',
        get() {
            const rawValue = this.getDataValue('registrations');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('registrations', JSON.stringify(value));
        }
    }
});

const Event = sequelize.define('Event', {
    // UI expects a manual numeric ID (like 101, 102), so we keep 'customId'
    customId: { type: DataTypes.INTEGER, unique: true }, 
    name: DataTypes.STRING,
    type: DataTypes.STRING,
    startDate: DataTypes.STRING,
    status: DataTypes.STRING,
    description: DataTypes.STRING,
    imageUrl: DataTypes.STRING
});

const Announcement = sequelize.define('Announcement', {
    customId: { type: DataTypes.INTEGER }, // UI uses 'id' for deletion
    title: DataTypes.STRING,
    content: DataTypes.STRING,
    date: DataTypes.STRING
});

// --- 3. INIT LOGIC (Sync Tables) ---
async function initDB() {
    try {
        await sequelize.sync(); 
        console.log("✅ Database Ready");

        // Create Admin if not exists
        const adminExists = await User.findOne({ where: { gid: 'Organizer' } });
        if (!adminExists) {
            await User.create({ gid: 'Organizer', name: 'Admin User', password: 'Admin', role: 'admin' });
        }
        
        // Create Default Student if not exists
        const studentExists = await User.findOne({ where: { gid: 'DKTE-STU-0001' } });
        if (!studentExists) {
            await User.create({ gid: 'DKTE-STU-0001', name: 'Aarav Kulkarni', password: '456', role: 'student', email: 'aarav@student.com', phone: '9876543210' });
        }
    } catch (err) {
        console.log("❌ DB Error:", err);
    }
}
initDB();

// --- MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

const authorizeAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    next();
};

// --- ROUTES (Logic kept identical for UI compatibility) ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// LOGIN
app.post('/api/login', async (req, res) => {
    const { gid, password } = req.body;
    const user = await User.findOne({ where: { gid, password } });
    if (user) {
        const token = jwt.sign({ gid: user.gid, role: user.role }, SECRET_KEY);
        // Clean output for UI
        const u = user.toJSON();
        delete u.password;
        delete u.createdAt; delete u.updatedAt;
        res.json({ success: true, token, ...u });
    } else {
        res.status(401).json({ success: false, message: 'Invalid Credentials' });
    }
});

// ADMIN: GET USERS
app.get('/api/users', authenticateToken, authorizeAdmin, async (req, res) => {
    const users = await User.findAll({ where: { role: 'student' } });
    res.json({ success: true, users });
});

// ADMIN: CREATE USER
app.post('/api/users', authenticateToken, authorizeAdmin, async (req, res) => {
    const count = await User.count({ where: { role: 'student' } });
    const newGID = `Aurapass-YCP-${String(count + 2).padStart(4, '0')}`;
    const newPassword = String(Math.floor(1000 + Math.random() * 9000));
    
    try {
        await User.create({ gid: newGID, name: req.body.name, password: newPassword, role: 'student' });
        res.status(201).json({ success: true, message: 'User created', user: { gid: newGID, password: newPassword } });
    } catch (e) {
        res.status(500).json({ message: 'Error creating user' });
    }
});

// ADMIN: DELETE USER
app.delete('/api/users/:gid', authenticateToken, authorizeAdmin, async (req, res) => {
    await User.destroy({ where: { gid: req.params.gid } });
    res.json({ success: true, message: 'User deleted' });
});

// GET EVENTS
app.get('/api/events', authenticateToken, async (req, res) => {
    const events = await Event.findAll();
    const allUsers = await User.findAll();
    
    // Map SQLite data to match exactly what UI expects (id = customId)
    const eventsWithCount = events.map(e => {
        const json = e.toJSON();
        // Count registrations manually since we store JSON string
        const count = allUsers.filter(u => u.registrations && u.registrations.some(r => r.eventId === json.customId)).length;
        return { 
            ...json, 
            id: json.customId, // IMPORTANT: Remap customId to id so UI works
            registrationCount: count 
        };
    });
    res.json({ success: true, events: eventsWithCount });
});

// ADMIN: CREATE EVENT
app.post('/api/events', authenticateToken, authorizeAdmin, async (req, res) => {
    const lastEvent = await Event.findOne({ order: [['customId', 'DESC']] });
    const newId = lastEvent ? lastEvent.customId + 1 : 101;
    const autoImageUrl = `https://picsum.photos/seed/${newId}/400/200`;
    
    await Event.create({ customId: newId, ...req.body, imageUrl: autoImageUrl });
    res.status(201).json({ success: true, message: 'Event created' });
});

// ADMIN: DELETE EVENT
app.delete('/api/events/:id', authenticateToken, authorizeAdmin, async (req, res) => {
    const evtId = parseInt(req.params.id);
    await Event.destroy({ where: { customId: evtId } });
    
    // Cleanup registrations in users
    const users = await User.findAll();
    for (const u of users) {
        let regs = u.registrations;
        const newRegs = regs.filter(r => r.eventId !== evtId);
        if (regs.length !== newRegs.length) {
            u.registrations = newRegs; // Setter handles stringify
            await u.save();
        }
    }
    res.json({ success: true, message: 'Event deleted' });
});

// REGISTER
app.post('/api/register', authenticateToken, async (req, res) => {
    const user = await User.findOne({ where: { gid: req.user.gid } });
    const event = await Event.findOne({ where: { customId: parseInt(req.body.eventId) } });
    
    if (!user || !event) return res.status(404).json({ message: 'Not found' });
    if (event.status === 'Closed') return res.status(400).json({ message: 'Event Closed' });
    
    const regs = user.registrations;
    if (regs.some(r => r.eventId === event.customId)) return res.status(400).json({ message: 'Already Registered' });

    regs.push({ eventId: event.customId, regDate: new Date().toISOString(), id: `REG-${Date.now()}` });
    
    // Force update because Sequelize sometimes misses array changes inside JSON
    user.changed('registrations', true); 
    user.registrations = regs;
    await user.save();
    
    res.json({ success: true, message: 'Registered Successfully!' });
});

// MY REGISTRATIONS
app.get('/api/myregistrations', authenticateToken, async (req, res) => {
    const user = await User.findOne({ where: { gid: req.user.gid } });
    const myRegs = [];
    const regs = user.registrations;
    
    for (let reg of regs) {
        const event = await Event.findOne({ where: { customId: reg.eventId } });
        if (event) {
            const eJson = event.toJSON();
            eJson.id = eJson.customId; // Fix ID for UI
            myRegs.push({ ...reg, event: eJson });
        }
    }
    res.json({ success: true, registrations: myRegs.reverse() });
});

// ADMIN: EVENT REGISTRATIONS
app.get('/api/events/:id/registrations', authenticateToken, authorizeAdmin, async (req, res) => {
    const evtId = parseInt(req.params.id);
    const event = await Event.findOne({ where: { customId: evtId } });
    const allUsers = await User.findAll();
    
    const relevantUsers = allUsers.filter(u => u.registrations.some(r => r.eventId === evtId));
    
    const list = relevantUsers.map(u => ({
        registrationId: u.registrations.find(r => r.eventId === evtId).id,
        gid: u.gid, name: u.name, email: u.email, phone: u.phone
    }));
    
    res.json({ success: true, eventName: event ? event.name : 'Unknown', registrations: list });
});

// ANNOUNCEMENTS
app.get('/api/announcements', authenticateToken, async (req, res) => {
    const anns = await Announcement.findAll({ order: [['id', 'DESC']] });
    // Map id to customId just in case, though for announcements simple ID works
    res.json({ success: true, announcements: anns });
});

app.post('/api/announcements', authenticateToken, authorizeAdmin, async (req, res) => {
    const last = await Announcement.findOne({ order: [['customId', 'DESC']] });
    const newId = last ? last.customId + 1 : 1;
    await Announcement.create({ customId: newId, ...req.body, date: new Date().toISOString() });
    res.json({ success: true, message: 'Posted' });
});

app.delete('/api/announcements/:id', authenticateToken, authorizeAdmin, async (req, res) => {
    // UI sends ID. Since default ID matches creation order usually, we try to match customId
    // But to be safe for your UI which sends 'id', we delete by customId if implemented or PK
    // Let's rely on Primary Key for announcements as they are simple
    await Announcement.destroy({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Deleted' });
});

app.get('/api/credentials', authenticateToken, authorizeAdmin, async (req, res) => {
    const users = await User.findAll({ where: { role: 'student' } });
    res.json({ success: true, credentials: users });
});

app.put('/api/profile', authenticateToken, async (req, res) => {
    const user = await User.findOne({ where: { gid: req.user.gid } });
    if (req.body.newPassword) {
        if (user.password !== req.body.currentPassword) return res.status(400).json({ message: 'Wrong Password' });
        user.password = req.body.newPassword;
    }
    if (req.body.newName) user.name = req.body.newName;
    if (req.body.email) user.email = req.body.email;
    if (req.body.phone) user.phone = req.body.phone;
    await user.save();
    res.json({ success: true, message: 'Profile Updated' });
});

// Vercel / Hostinger export
if (require.main === module) {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;