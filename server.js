const express = require('express');
const wppconnect = require('@wppconnect-team/wppconnect');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const userOperations = require('./database');
const schedule = require('node-schedule');

const app = express();
const port = 3000;

// WebSocket için http server oluştur
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware
app.use(session({
    secret: 'whatsapp-message-sender-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // HTTPS kullanılmıyorsa false olmalı
}));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Oturum kontrolü middleware
const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

// Configure multer for file uploads
const upload = multer({
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadDir = path.join(__dirname, 'uploads');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir);
            }
            cb(null, uploadDir);
        },
        filename: function (req, file, cb) {
            cb(null, 'policeler.xlsx');
        }
    }),
    fileFilter: function (req, file, cb) {
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            file.mimetype === 'application/vnd.ms-excel') {
            cb(null, true);
        } else {
            cb(new Error('Sadece Excel dosyaları yüklenebilir!'));
        }
    }
});

let clients = {};
let isConnectedStatus = {};
let groups = [];

// Her kullanıcı için ayrı otomatik mesaj programlayıcısı
const scheduledJobs = {};

// Initialize WPPConnect
async function initializeWhatsApp(userId) {
    try {
        const sessionName = `whatsapp-session-${userId}`;
        const tokenPath = path.join(__dirname, 'tokens', sessionName);

        // Önceki oturum verilerini kontrol et
        const sessionExists = fs.existsSync(tokenPath);

        clients[userId] = await wppconnect.create({
            session: sessionName,
            catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
                console.log('QR Code received', asciiQR);
                io.emit('qr', base64Qr);
                
                // 3 denemeden sonra QR kodu yenilemek için bildirim gönder
                if (attempts >= 3) {
                    io.emit('qr-retry', {
                        message: 'QR kod zaman aşımına uğradı. Yenilemek için sayfayı yenileyin.'
                    });
                }
            },
            statusFind: (statusSession, session) => {
                console.log('Status Session:', statusSession);
                console.log('Session name:', session);
                
                if (statusSession === 'inChat' || statusSession === 'isLogged') {
                    isConnectedStatus[userId] = true;
                    io.emit('connection-status', true);
                    
                    // Oturum başarıyla kurulduğunda veritabanına kaydet
                    userOperations.saveWhatsAppSession(userId, {
                        sessionName,
                        lastConnection: new Date(),
                        status: 'active'
                    });

                    // WhatsApp bağlantısı kurulduğunda tüm programlamaları yeniden başlat
                    rescheduleAllMessages(userId);
                }
            },
            onLoadingScreen: (percent, message) => {
                console.log('LOADING_SCREEN', percent, message);
            },
            headless: true,
            devtools: false,
            useChrome: true,
            debug: false,
            logQR: true,
            browserWS: '',
            browserArgs: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ],
            puppeteerOptions: {
                executablePath: process.platform === 'win32' ? 
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 
                    '/usr/bin/google-chrome',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox'
                ]
            },
            disableWelcome: true,
            updatesLog: true,
            autoClose: 0, // Otomatik kapanmayı devre dışı bırak
            createPathFileToken: true, // Token dosyası oluşturmayı etkinleştir
            waitForLogin: true, // Giriş yapılana kadar bekle
        });

        // Bağlantı kopması durumunda yeniden bağlanma
        clients[userId].onStateChange((state) => {
            console.log('State changed:', state);
            const connected = state === 'CONNECTED';
            if (connected !== isConnectedStatus[userId]) {
                isConnectedStatus[userId] = connected;
                io.emit('connection-status', isConnectedStatus[userId]);
                
                if (isConnectedStatus[userId]) {
                    // Bağlantı yeniden sağlandığında grupları güncelle
                    refreshGroups(userId);
                    
                    // Otomatik mesaj gönderme programlayıcısını ayarla
                    rescheduleAllMessages(userId);
                } else {
                    // Bağlantı koptuğunda kullanıcıya bildir
                    io.emit('connection-lost', {
                        message: 'WhatsApp bağlantısı koptu. Yeniden bağlanmaya çalışılıyor...'
                    });
                    
                    // Yeniden bağlanmayı dene
                    setTimeout(() => {
                        if (!isConnectedStatus[userId]) {
                            initializeWhatsApp(userId);
                        }
                    }, 5000);
                }
            }
        });

        // Grupları yenileme fonksiyonu
        async function refreshGroups(userId) {
            try {
                const chats = await clients[userId].listChats();
                groups[userId] = chats
                    .filter(chat => chat.isGroup)
                    .map(group => ({
                        id: group.id._serialized || group.id,
                        name: group.name || group.formattedTitle,
                        participantsCount: group.groupMetadata?.participants?.length || 0
                    }));
                io.emit('groups-updated', groups[userId]);
            } catch (error) {
                console.error('Error refreshing groups:', error);
            }
        }

        // Başlangıçta bağlantı durumunu kontrol et
        const state = await clients[userId].getConnectionState();
        isConnectedStatus[userId] = state === 'CONNECTED';
        io.emit('connection-status', isConnectedStatus[userId]);

        if (isConnectedStatus[userId]) {
            refreshGroups(userId);
        }

        clients[userId].onMessage((message) => {
            console.log('Message received:', message);
        });

        console.log('WhatsApp client initialized successfully');
        return true;
    } catch (error) {
        console.error('Error initializing WhatsApp client:', error);
        return false;
    }
}

// Auth Routes
app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await userOperations.verifyUser(email, password);
        if (user) {
            req.session.userId = user.id;
            // Kullanıcı girişi başarılı olduğunda WhatsApp'ı başlat
            await initializeWhatsApp(user.id);
            res.redirect('/');
        } else {
            res.render('login', { error: 'Geçersiz e-posta veya şifre' });
        }
    } catch (error) {
        res.render('login', { error: 'Giriş yapılırken bir hata oluştu' });
    }
});

app.get('/register', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const { username, email, password, confirmPassword } = req.body;
    
    if (password !== confirmPassword) {
        return res.render('register', { error: 'Şifreler eşleşmiyor' });
    }

    try {
        await userOperations.createUser(username, email, password);
        res.redirect('/login');
    } catch (error) {
        res.render('register', { 
            error: 'Kayıt olurken bir hata oluştu. E-posta veya kullanıcı adı zaten kullanımda olabilir.' 
        });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Protected Routes
app.get('/', requireLogin, async (req, res) => {
    let groups = [];
    let message = req.query.message || null;
    let messageType = req.query.type || 'info';

    // Eğer client yoksa veya bağlı değilse, yeniden başlatmayı dene
    if (!clients[req.session.userId] || !isConnectedStatus[req.session.userId]) {
        await initializeWhatsApp(req.session.userId);
    }

    if (isConnectedStatus[req.session.userId] && clients[req.session.userId]) {
        try {
            const allChats = await clients[req.session.userId].listChats();
            groups = allChats
                .filter(chat => chat.isGroup)
                .map(group => ({
                    id: group.id._serialized || group.id,
                    name: group.name || group.formattedTitle,
                    participantsCount: group.groupMetadata?.participants?.length || 0
                }));
        } catch (error) {
            console.error('Error fetching groups:', error);
        }
    }

    const user = await userOperations.getUserById(req.session.userId);

    res.render('index', {
        connected: isConnectedStatus[req.session.userId],
        groups: groups,
        message: message,
        messageType: messageType,
        user: user,
        setting: {}
    });
});

app.post('/upload', requireLogin, upload.single('excelFile'), async (req, res) => {
    if (!req.file) {
        return res.json({ success: false, error: 'Dosya yüklenemedi!' });
    }

    try {
        // Excel dosyasını veritabanına kaydet
        const fileData = {
            userId: req.session.userId,
            originalName: req.file.originalname,
            filePath: req.file.path,
            uploadDate: new Date()
        };
        
        const fileId = await userOperations.saveExcelFile(fileData);
        
        // Excel verilerini işle
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // Excel verilerini JSON formatına dönüştür - raw:true kullanarak orijinal değerleri alalım
        const rawData = xlsx.utils.sheet_to_json(worksheet, { 
            raw: true, 
            defval: '', 
            header: 0 
        });
        
        // Verileri doğru formatta işle
        global.excelData = rawData.map(row => {
            // Sütun isimlerini kontrol et
            const bitisCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('bitiş') || 
                key.toLowerCase().includes('bitis'));
            
            const musteriCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('müşteri') || 
                key.toLowerCase().includes('musteri'));
            
            const plakaCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('plaka'));
            
            const primCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('prim'));
            
            const sirketCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('şirket') || 
                key.toLowerCase().includes('sirket'));
            
            // Brüt primi sayısal değer olarak alalım
            let brutPrim = primCol ? row[primCol] : '';
            
            return {
                BitisTarihi: bitisCol ? row[bitisCol] : '',
                MusteriAdi: musteriCol ? row[musteriCol] : '',
                Plaka: plakaCol ? row[plakaCol] : '',
                Prim: brutPrim,  // Sayısal değer olarak saklayalım
                Sirket: sirketCol ? row[sirketCol] : ''
            };
        });
        
        res.json({ 
            success: true, 
            message: 'Dosya başarıyla yüklendi!',
            fileId: fileId 
        });
    } catch (error) {
        console.error('Error processing Excel file:', error);
        res.json({ 
            success: false, 
            error: 'Excel dosyası işlenirken hata oluştu: ' + error.message 
        });
    }
});

app.post('/send-message', requireLogin, async (req, res) => {
    if (!isConnectedStatus[req.session.userId] || !clients[req.session.userId]) {
        return res.json({ success: false, error: 'WhatsApp bağlantısı yok!' });
    }

    const { groupId } = req.body;
    if (!groupId) {
        return res.json({ success: false, error: 'Grup ID gerekli!' });
    }

    if (!global.excelData || !global.excelData.length) {
        return res.json({ success: false, error: 'Önce Excel dosyası yükleyin!' });
    }

    try {
        // Excel'den gelen tarihleri ve bugünü karşılaştır
        const todayStr = new Date().toLocaleDateString('tr-TR');
        console.log(`Bugünün tarihi (Türkçe format): ${todayStr}`);
        
        // Bugün sona erecek poliçeleri filtrele
        const expiringToday = global.excelData.filter(item => {
            if (!item.BitisTarihi) return false;
            
            let itemDateStr = '';
            let excelDateObj = null;
            
            // Excel'den farklı tiplerde gelebilecek tarih değerlerini işle
            if (typeof item.BitisTarihi === 'string') {
                // Zaten string olan tarihi olduğu gibi kullan
                itemDateStr = item.BitisTarihi;
            } else if (item.BitisTarihi instanceof Date) {
                // Date nesnesi ise Türkçe formatına çevir
                itemDateStr = item.BitisTarihi.toLocaleDateString('tr-TR');
            } else if (typeof item.BitisTarihi === 'number') {
                try {
                    // Excel sayısal tarih değeri (örneğin 45720)
                    excelDateObj = new Date(Math.round((item.BitisTarihi - 25569) * 86400 * 1000));
                    // Eğer geçerli bir tarih ise formatla
                    if (!isNaN(excelDateObj.getTime())) {
                        const day = excelDateObj.getDate().toString().padStart(2, '0');
                        const month = (excelDateObj.getMonth() + 1).toString().padStart(2, '0');
                        const year = excelDateObj.getFullYear();
                        itemDateStr = `${day}.${month}.${year}`;
                        
                        // BitisTarihi değerini de güncelle ki mesajda doğru gösterilsin
                        item.BitisTarihi = itemDateStr;
                    } else {
                        console.log(`Geçersiz Excel sayısal tarih değeri: ${item.BitisTarihi}`);
                        return false;
                    }
                } catch (err) {
                    console.error(`Tarih dönüştürme hatası: ${err.message}`);
                    return false;
                }
            } else {
                console.log(`Tanımlanamayan tarih formatı: ${typeof item.BitisTarihi}`);
                return false;
            }
            
            // Tarih string'lerini normalize et (başındaki 0'ları kaldır)
            const normalizeDate = (dateStr) => {
                const parts = dateStr.split('.');
                if (parts.length !== 3) return dateStr;
                
                // Başındaki 0'ları kaldır ve tekrar birleştir
                const day = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10);
                const year = parts[2];
                
                return `${day}.${month}.${year}`;
            };
            
            const normalizedItemDate = normalizeDate(itemDateStr);
            const normalizedToday = normalizeDate(todayStr);
            
            console.log(`Karşılaştırılıyor: Poliçe tarihi: "${normalizedItemDate}", Bugün: "${normalizedToday}"`);
            
            // Tarih string'lerini karşılaştır
            return normalizedItemDate === normalizedToday;
        });
        
        // Eğer bugün biten poliçe yoksa mesaj gönderme
        if (expiringToday.length === 0) {
            console.log('Bugün biten poliçe bulunmadı, mesaj gönderilmiyor.');
            return;
        }
        
        // Mesaj metni oluştur
        let messageText = `🚨 BUGÜN BİTEN POLİÇELER (${todayStr}):\n\n`;
        expiringToday.forEach((item, index) => {
            messageText += `📋 Müşteri: ${item.MusteriAdi}\n`;
            messageText += `🚗 Plaka: ${item.Plaka}\n`;
            messageText += `📅 Bitiş Tarihi: ${item.BitisTarihi}\n`;
            messageText += `💰 Brüt Prim: ${item.Prim}\n`;
            messageText += `🏢 Şirket: ${item.Sirket}\n`;
            messageText += `➖➖➖➖➖➖➖➖➖\n\n`;
        });
        
        // Son bilgilendirme mesajı ekle
        messageText += `⚠️ Toplam ${expiringToday.length} adet poliçe bugün bitiyor. Lütfen ilgili müşterilerle iletişime geçiniz.`;
        
        await clients[req.session.userId].sendText(groupId, messageText);
        
        // Mesajı veritabanına kaydet
        await userOperations.logMessage(req.session.userId, groupId, messageText);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error sending message:', error);
        res.json({ success: false, error: error.message });
    }
});

// WebSocket bağlantı yönetimi
io.on('connection', (socket) => {
    console.log('Client connected');
    
    // Kullanıcı bağlandığında varsayılan durum - bağlı değil
    socket.emit('connection-status', false);

    // Socket üzerinden kullanıcı kimliğini al
    socket.on('user-session', async (userId) => {
        console.log(`User session received: ${userId}`);
        socket.userId = userId; // Socket'e kullanıcı kimliğini kaydet
        
        if (userId && (!clients[userId] || !isConnectedStatus[userId])) {
            console.log(`Initializing WhatsApp for user ${userId}`);
            await initializeWhatsApp(userId);
        }
        
        // Kullanıcıya özel bağlantı durumunu gönder
        if (isConnectedStatus[userId]) {
            socket.emit('connection-status', isConnectedStatus[userId]);
            socket.emit('groups-updated', groups[userId] || []);
        }
    });
});

// Programlayıcı fonksiyonu
async function scheduleMessageSending(userId, settingId) {
    try {
        // Ayarları getir
        const settings = await userOperations.getAutoMessageSettings(userId);
        const setting = settings.find(s => s.id === settingId);
        
        if (!setting) {
            console.error(`Setting not found for user ${userId} and setting ${settingId}`);
            return;
        }

        // Eğer daha önceden ayarlanmış bir program varsa iptal et
        const jobKey = `${userId}_${settingId}`;
        if (scheduledJobs[jobKey]) {
            scheduledJobs[jobKey].cancel();
        }

        let job;
        if (setting.schedule_type === 'daily') {
            // Günlük programlama
            const [hour, minute] = setting.schedule_time.split(':');
            const cronExpression = `${minute} ${hour} * * *`;
            job = schedule.scheduleJob(cronExpression, () => sendScheduledMessage(userId, setting));
        } else {
            // Saatlik veya dakikalık programlama
            // nextSendAt değerini alın, yoksa hesaplayın
            let nextSendAt;
            const now = new Date();
            
            if (setting.next_send_at) {
                try {
                    nextSendAt = new Date(setting.next_send_at);
                    // Geçerli bir tarih değeri mi kontrol et
                    if (isNaN(nextSendAt.getTime())) {
                        console.error(`Geçersiz next_send_at değeri: ${setting.next_send_at}, yeni tarih oluşturuluyor...`);
                        // Geçersiz tarih değeri, yeni bir tarih oluştur
                        if (setting.schedule_type === 'hourly') {
                            nextSendAt = new Date(now.getTime() + setting.interval_hours * 60 * 60 * 1000);
                        } else if (setting.schedule_type === 'minute') {
                            nextSendAt = new Date(now.getTime() + setting.interval_minutes * 60 * 1000);
                        } else {
                            nextSendAt = new Date(now.getTime() + 60 * 60 * 1000); // Varsayılan olarak 1 saat sonra
                        }
                    } else {
                        console.log(`Mevcut sonraki gönderim zamanı: ${nextSendAt.toLocaleString('tr-TR')}`);
                        
                        // Eğer planlanan zaman geçmişse veya çok yakınsa (30 saniyeden az), şu anki zamandan itibaren interval kadar ileri taşı
                        if (nextSendAt <= now || (nextSendAt.getTime() - now.getTime()) < 30000) {
                            console.log(`Sonraki gönderim zamanı geçmiş veya çok yakın, yeniden hesaplanıyor...`);
                            
                            if (setting.schedule_type === 'hourly') {
                                nextSendAt = new Date(now.getTime() + setting.interval_hours * 60 * 60 * 1000);
                            } else if (setting.schedule_type === 'minute') {
                                nextSendAt = new Date(now.getTime() + setting.interval_minutes * 60 * 1000);
                            }
                            
                            console.log(`Yeni sonraki gönderim zamanı: ${nextSendAt.toLocaleString('tr-TR')}`);
                        }
                    }
                } catch (error) {
                    console.error(`Tarih dönüştürme hatası: ${error.message}, yeni tarih oluşturuluyor...`);
                    if (setting.schedule_type === 'hourly') {
                        nextSendAt = new Date(now.getTime() + setting.interval_hours * 60 * 60 * 1000);
                    } else if (setting.schedule_type === 'minute') {
                        nextSendAt = new Date(now.getTime() + setting.interval_minutes * 60 * 1000);
                    } else {
                        nextSendAt = new Date(now.getTime() + 60 * 60 * 1000); // Varsayılan olarak 1 saat sonra
                    }
                }
            } else {
                // Sonraki gönderim zamanı ayarlanmamışsa, şu anki zamandan itibaren interval kadar ileri ayarla
                if (setting.schedule_type === 'hourly') {
                    nextSendAt = new Date(now.getTime() + setting.interval_hours * 60 * 60 * 1000);
                } else if (setting.schedule_type === 'minute') {
                    // interval_minutes değeri undefined veya geçersiz olabilir, kontrol edelim
                    const intervalMinutes = setting.interval_minutes || 5; // Varsayılan 5 dakika
                    console.log(`Dakikalık zamanlama için interval: ${intervalMinutes} dakika`);
                    nextSendAt = new Date(now.getTime() + intervalMinutes * 60 * 1000);
                } else {
                    nextSendAt = new Date(now.getTime() + 60 * 60 * 1000); // Varsayılan olarak 1 saat sonra
                }
                
                console.log(`Sonraki gönderim zamanı ayarlanmamış, yeni zaman: ${nextSendAt.toLocaleString('tr-TR')}`);
            }
            
            console.log(`Scheduling message for setting ${settingId} at: ${nextSendAt.toLocaleString('tr-TR')}`);
            
            // Veritabanında next_send_at'i güncelle (job'ı kaçırması durumuna karşı)
            await userOperations.updateNextSendTime(setting.id, nextSendAt.toISOString());
            
            // Veritabanında ayrıca son gönderim zamanını da güncelle
            await userOperations.updateAutoMessageTimings(setting.id, now.toISOString(), nextSendAt.toISOString());

            // Socket üzerinden bilgileri güncelle
            io.emit('message-sent', { 
                settingId: setting.id,
                lastSentAt: now.toLocaleString('tr-TR'),
                nextSendAt: nextSendAt.toLocaleString('tr-TR')
            });
            
            // Belirli bir tarih için job oluştur
            job = schedule.scheduleJob(nextSendAt, function() {
                console.log(`Job executed at ${new Date().toLocaleString('tr-TR')} for setting ${settingId}`);
                sendScheduledMessage(userId, setting);
            });
        }

        scheduledJobs[jobKey] = job;
        console.log(`Scheduled message for user ${userId}, setting ${settingId}, type: ${setting.schedule_type}`);
    } catch (error) {
        console.error('Error scheduling message:', error);
    }
}

// Programlanmış mesaj gönderme fonksiyonu
async function sendScheduledMessage(userId, setting) {
    try {
        console.log(`Running scheduled message for user ${userId}, setting ${setting.id}`);

        // WhatsApp bağlantısını kontrol et
        if (!isConnectedStatus[userId] || !clients[userId]) {
            console.log(`WhatsApp client not connected for user ${userId}`);
            return;
        }

        // Excel dosyasını oku
        const excelFile = await userOperations.getExcelFiles(userId)
            .then(files => files.find(f => f.id === setting.excel_file_id));

        if (!excelFile) {
            console.error(`Excel file not found for setting ${setting.id}`);
            return;
        }

        // Excel verilerini oku
        const workbook = xlsx.readFile(excelFile.file_path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // Excel verilerini JSON formatına dönüştür - raw:true kullanarak orijinal değerleri alalım
        const rawData = xlsx.utils.sheet_to_json(worksheet, { 
            raw: true, 
            defval: '', 
            header: 0 
        });
        
        // Verileri doğru formatta işle
        const processedData = rawData.map(row => {
            // Sütun isimlerini kontrol et
            const bitisCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('bitiş') || 
                key.toLowerCase().includes('bitis'));
            
            const musteriCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('müşteri') || 
                key.toLowerCase().includes('musteri'));
            
            const plakaCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('plaka'));
            
            const primCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('prim'));
            
            const sirketCol = Object.keys(row).find(key => 
                key.toLowerCase().includes('şirket') || 
                key.toLowerCase().includes('sirket'));
            
            // Brüt primi sayısal değer olarak alalım
            let brutPrim = primCol ? row[primCol] : '';
            let formattedPrim = '';

            if (brutPrim !== '') {
                // Sayı veya string olabilir, uygun şekilde dönüştür
                let numValue = brutPrim;
                
                // String ise ve Türkçe formatındaysa düzelt (1.234,56 -> 1234.56)
                if (typeof numValue === 'string') {
                    numValue = numValue.replace(/\./g, '').replace(',', '.');
                    numValue = parseFloat(numValue);
                }
                
                // Geçerli bir sayı ise formatla
                if (!isNaN(numValue)) {
                    formattedPrim = numValue.toLocaleString('tr-TR', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2
                    }) + ' TL';
                } else {
                    formattedPrim = brutPrim; // Sayıya dönüştürülemiyorsa orijinali kullan
                }
            }
            
            return {
                BitisTarihi: bitisCol ? row[bitisCol] : '',
                MusteriAdi: musteriCol ? row[musteriCol] : '',
                Plaka: plakaCol ? row[plakaCol] : '',
                Prim: formattedPrim,
                Sirket: sirketCol ? row[sirketCol] : ''
            };
        });

        // Excel'den gelen tarihleri ve bugünü karşılaştır
        const todayStr = new Date().toLocaleDateString('tr-TR');
        console.log(`Bugünün tarihi (Türkçe format): ${todayStr}`);
        
        // Bugün sona erecek poliçeleri filtrele
        const expiringToday = processedData.filter(item => {
            if (!item.BitisTarihi) return false;
            
            let itemDateStr = '';
            let excelDateObj = null;
            
            // Excel'den farklı tiplerde gelebilecek tarih değerlerini işle
            if (typeof item.BitisTarihi === 'string') {
                // Zaten string olan tarihi olduğu gibi kullan
                itemDateStr = item.BitisTarihi;
            } else if (item.BitisTarihi instanceof Date) {
                // Date nesnesi ise Türkçe formatına çevir
                itemDateStr = item.BitisTarihi.toLocaleDateString('tr-TR');
            } else if (typeof item.BitisTarihi === 'number') {
                try {
                    // Excel sayısal tarih değeri (örneğin 45720)
                    excelDateObj = new Date(Math.round((item.BitisTarihi - 25569) * 86400 * 1000));
                    // Eğer geçerli bir tarih ise formatla
                    if (!isNaN(excelDateObj.getTime())) {
                        const day = excelDateObj.getDate().toString().padStart(2, '0');
                        const month = (excelDateObj.getMonth() + 1).toString().padStart(2, '0');
                        const year = excelDateObj.getFullYear();
                        itemDateStr = `${day}.${month}.${year}`;
                        
                        // BitisTarihi değerini de güncelle ki mesajda doğru gösterilsin
                        item.BitisTarihi = itemDateStr;
                    } else {
                        console.log(`Geçersiz Excel sayısal tarih değeri: ${item.BitisTarihi}`);
                        return false;
                    }
                } catch (err) {
                    console.error(`Tarih dönüştürme hatası: ${err.message}`);
                    return false;
                }
            } else {
                console.log(`Tanımlanamayan tarih formatı: ${typeof item.BitisTarihi}`);
                return false;
            }
            
            // Tarih string'lerini normalize et (başındaki 0'ları kaldır)
            const normalizeDate = (dateStr) => {
                const parts = dateStr.split('.');
                if (parts.length !== 3) return dateStr;
                
                // Başındaki 0'ları kaldır ve tekrar birleştir
                const day = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10);
                const year = parts[2];
                
                return `${day}.${month}.${year}`;
            };
            
            const normalizedItemDate = normalizeDate(itemDateStr);
            const normalizedToday = normalizeDate(todayStr);
            
            console.log(`Karşılaştırılıyor: Poliçe tarihi: "${normalizedItemDate}", Bugün: "${normalizedToday}"`);
            
            // Tarih string'lerini karşılaştır
            return normalizedItemDate === normalizedToday;
        });
        
        // Eğer bugün biten poliçe yoksa mesaj gönderme
        if (expiringToday.length === 0) {
            console.log('Bugün biten poliçe bulunmadı, mesaj gönderilmiyor.');
            return;
        }
        
        // Mesaj metni oluştur
        let messageText = `🚨 BUGÜN BİTEN POLİÇELER (${todayStr}):\n\n`;
        expiringToday.forEach((item, index) => {
            messageText += `📋 Müşteri: ${item.MusteriAdi}\n`;
            messageText += `🚗 Plaka: ${item.Plaka}\n`;
            messageText += `📅 Bitiş Tarihi: ${item.BitisTarihi}\n`;
            messageText += `💰 Brüt Prim: ${item.Prim}\n`;
            messageText += `🏢 Şirket: ${item.Sirket}\n`;
            messageText += `➖➖➖➖➖➖➖➖➖\n\n`;
        });
        
        // Son bilgilendirme mesajı ekle
        messageText += `⚠️ Toplam ${expiringToday.length} adet poliçe bugün bitiyor. Lütfen ilgili müşterilerle iletişime geçiniz.`;
        
        // Mesajı gönder
        await clients[userId].sendText(setting.group_id, messageText);
        console.log(`Message sent to group ${setting.group_id}`);
        
        // Bir sonraki zamanlamayı ayarla
        const now = new Date();
        let nextSendAt = new Date();

        try {
            // Bir sonraki gönderim zamanını belirle
            if (setting.schedule_type === 'daily') {
                // Günlük programlama - saat ve dakikayı ayarla
                const [hour, minute] = setting.schedule_time.split(':');
                nextSendAt.setHours(parseInt(hour), parseInt(minute), 0, 0);
                
                // Eğer bugün için zaman geçtiyse yarına ayarla
                if (nextSendAt <= now) {
                    nextSendAt.setDate(nextSendAt.getDate() + 1);
                }
            } else if (setting.schedule_type === 'hourly') {
                // Saatlik programlama - interval_hours sonra gönderilecek
                nextSendAt.setTime(now.getTime() + setting.interval_hours * 60 * 60 * 1000);
            } else if (setting.schedule_type === 'minute') {
                // Dakikalık programlama - interval_minutes sonra gönderilecek
                const intervalMinutes = setting.interval_minutes || 5; // Varsayılan 5 dakika
                console.log(`Dakikalık zamanlama, sonraki gönderim için dakika: ${intervalMinutes}`);
                nextSendAt.setTime(now.getTime() + intervalMinutes * 60 * 1000);
            }
            
            console.log(`Bir sonraki mesaj gönderim zamanı: ${nextSendAt.toLocaleString('tr-TR')}`);
            
            // Veritabanında sonraki gönderim zamanını güncelle
            await userOperations.updateNextSendTime(setting.id, nextSendAt.toISOString());
            
            // Veritabanında ayrıca son gönderim zamanını da güncelle
            await userOperations.updateAutoMessageTimings(setting.id, now.toISOString(), nextSendAt.toISOString());

            // Socket üzerinden bilgileri güncelle
            io.emit('message-sent', { 
                settingId: setting.id,
                lastSentAt: now.toLocaleString('tr-TR'),
                nextSendAt: nextSendAt.toLocaleString('tr-TR')
            });
            
            // Yeni zamanlama oluştur
            scheduleMessageSending(userId, setting.id);
        } catch (error) {
            console.error(`Sonraki zamanlama oluşturulurken hata: ${error.message}`);
            // Hata durumunda varsayılan bir zamanlama oluştur
            nextSendAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 saat sonra
            await userOperations.updateNextSendTime(setting.id, nextSendAt.toISOString());
            scheduleMessageSending(userId, setting.id);
        }
    } catch (error) {
        console.error('Error sending scheduled message:', error);
    }
}

// Kullanıcının tüm ayarlarını yeniden programla
async function rescheduleAllMessages(userId) {
    try {
        // Kullanıcının WhatsApp bağlantısını kontrol et
        if (!clients[userId] || !isConnectedStatus[userId]) {
            console.log(`WhatsApp client not connected for user ${userId}, skipping message scheduling`);
            return;
        }

        const settings = await userOperations.getAutoMessageSettings(userId);
        console.log(`${userId} kullanıcısı için ${settings.length} ayar yeniden programlanıyor...`);
        
        settings.forEach(async (setting) => {
            // Son gönderim zamanını kontrol et
            const lastSentAt = setting.last_sent_at ? new Date(setting.last_sent_at) : null;
            const nextSendAt = setting.next_send_at ? new Date(setting.next_send_at) : null;
            const now = new Date();
            
            console.log(`Ayar ID: ${setting.id}, Tipi: ${setting.schedule_type}`);
            console.log(`Son gönderim: ${lastSentAt ? lastSentAt.toLocaleString('tr-TR') : 'Yok'}`);
            console.log(`Sonraki planlanan: ${nextSendAt ? nextSendAt.toLocaleString('tr-TR') : 'Yok'}`);
            
            // Eğer son gönderim zamanı bugün ise ve sonraki gönderim zamanı henüz gelmediyse,
            // sadece sonraki gönderim için programla
            if (lastSentAt && isSameDay(lastSentAt, now) && nextSendAt && nextSendAt > now) {
                console.log(`Bugün zaten mesaj gönderilmiş, sonraki gönderim için zamanlanıyor: ${nextSendAt.toLocaleString('tr-TR')}`);
                await scheduleMessageSending(userId, setting.id);
            } else if (!lastSentAt || !nextSendAt) {
                // Hiç gönderim yapılmamışsa veya sonraki gönderim zamanı ayarlanmamışsa zamanla
                console.log(`Önceki gönderim bulunamadı, yeni zamanlama yapılıyor...`);
                await scheduleMessageSending(userId, setting.id);
            } else {
                // Sonraki gönderim zamanı geçmişse hemen gönder, değilse zamanla
                if (nextSendAt <= now) {
                    console.log(`Sonraki gönderim zamanı (${nextSendAt.toLocaleString('tr-TR')}) geçmiş, şimdi gönderiliyor...`);
                    await sendScheduledMessage(userId, setting);
                } else {
                    console.log(`Sonraki gönderim zamanı için (${nextSendAt.toLocaleString('tr-TR')}) zamanlanıyor...`);
                    await scheduleMessageSending(userId, setting.id);
                }
            }
        });
    } catch (error) {
        console.error('Error rescheduling messages:', error);
    }
}

// İki tarihin aynı gün olup olmadığını kontrol et
function isSameDay(date1, date2) {
    return date1.getDate() === date2.getDate() &&
           date1.getMonth() === date2.getMonth() &&
           date1.getFullYear() === date2.getFullYear();
}

// Manuel mesaj gönderme kontrolü
app.get('/check-policies', requireLogin, async (req, res) => {
    try {
        // Programlı mesaj gönderme işlemini manuel olarak başlat
        if (!isConnectedStatus[req.session.userId] || !clients[req.session.userId]) {
            return res.json({ success: false, error: 'WhatsApp bağlantısı yok!' });
        }

        // Kullanıcının aktif ayarlarını getir
        const settings = await userOperations.getAutoMessageSettings(req.session.userId);
        
        if (settings.length === 0) {
            return res.json({ 
                success: false, 
                error: 'Hiç otomatik mesaj ayarı bulunamadı! Lütfen önce ayarları yapılandırın.' 
            });
        }

        // Her ayar için programlamayı yeniden başlat
        for (const setting of settings) {
            await scheduleMessageSending(req.session.userId, setting.id);
        }
            
        res.json({ 
            success: true, 
            message: 'Otomatik mesaj gönderme ayarları güncellendi.',
            settings: settings
        });
    } catch (error) {
        console.error('Error checking policies:', error);
        res.json({ success: false, error: error.message });
    }
});

// WhatsApp gruplarını yenileme route'u
app.post('/refresh-groups', requireLogin, async (req, res) => {
    try {
        if (!isConnectedStatus[req.session.userId] || !clients[req.session.userId]) {
            return res.json({ success: false, error: 'WhatsApp bağlantısı yok!' });
        }

        const chats = await clients[req.session.userId].listChats();
        const updatedGroups = chats
            .filter(chat => chat.isGroup)
            .map(group => ({
                id: group.id._serialized || group.id,
                name: group.name || group.formattedTitle,
                participantsCount: group.groupMetadata?.participants?.length || 0
            }));
        
        groups[req.session.userId] = updatedGroups;
        
        return res.json({ success: true, groups: updatedGroups });
    } catch (error) {
        console.error('Error refreshing groups:', error);
        return res.json({ success: false, error: 'Gruplar yenilenirken bir hata oluştu!' });
    }
});

// Excel dosyalarını listeleme route'u
app.get('/excel-files', requireLogin, async (req, res) => {
    try {
        const files = await userOperations.getExcelFiles(req.session.userId);
        res.json({ success: true, files });
    } catch (error) {
        console.error('Error fetching excel files:', error);
        res.json({ success: false, error: error.message });
    }
});

// Excel dosyası silme route'u
app.delete('/excel-files/:id', requireLogin, async (req, res) => {
    try {
        await userOperations.deleteExcelFile(req.params.id, req.session.userId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting excel file:', error);
        res.json({ success: false, error: error.message });
    }
});

// Otomatik mesaj ayarları route'ları
app.post('/auto-message-settings', requireLogin, async (req, res) => {
    try {
        const { groupId, excelFileId, scheduleType, scheduleTime, intervalHours, intervalMinutes, id: settingId } = req.body;
        
        console.log("Gelen POST verisi:", req.body);
        
        if (!groupId || !excelFileId || !scheduleType) {
            return res.json({ success: false, error: 'Tüm alanları doldurunuz' });
        }
        
        // Önceden gönderilmiş ayarları varsa kontrol et
        const settings = await userOperations.getAutoMessageSettings(req.session.userId);
        
        if (settings.some(s => s.group_id === groupId && (!settingId || s.id !== parseInt(settingId)))) {
            return res.json({ 
                success: false, 
                error: 'Bu grup için zaten bir otomatik mesaj ayarı bulunmakta' 
            });
        }
        
        // Ayarları veritabanına kaydet
        const settingData = {
            user_id: req.session.userId,
            group_id: groupId,
            excel_file_id: excelFileId,
            schedule_type: scheduleType,
            schedule_time: scheduleType === 'daily' ? scheduleTime : '00:00', // Varsayılan bir saat atıyoruz
            interval_hours: scheduleType === 'hourly' ? parseInt(intervalHours) : 1, // Varsayılan 1 saat atıyoruz
            interval_minutes: scheduleType === 'minute' ? parseInt(intervalMinutes) : 5 // Varsayılan 5 dakika atıyoruz
        };
        
        console.log("Veritabanına kaydedilecek veri:", settingData);
        
        let resultId;
        
        if (settingId) {
            // Mevcut ayarı güncelle
            await userOperations.updateAutoMessageSettings(settingId, settingData);
            resultId = settingId;
            
            // Eğer bir job zaten planlanmışsa iptal et
            if (scheduledJobs[`${req.session.userId}_${settingId}`]) {
                scheduledJobs[`${req.session.userId}_${settingId}`].cancel();
            }
        } else {
            // Yeni ayar oluştur
            resultId = await userOperations.saveAutoMessageSettings(settingData);
        }
        
        // Yeni ayarlar için zamanlamayı başlat
        if (resultId) {
            scheduleMessageSending(req.session.userId, resultId);
            console.log(`${resultId} ID'li ayar için zamanlama başlatıldı`);
        } else {
            console.error("Kayıt sonucu ID alınamadı");
        }
        
        res.json({ success: true, id: resultId });
    } catch (error) {
        console.error('Error saving auto message settings:', error);
        res.json({ success: false, error: error.message });
    }
});

app.get('/auto-message-settings', requireLogin, async (req, res) => {
    try {
        const settings = await userOperations.getAutoMessageSettings(req.session.userId);
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Error fetching auto message settings:', error);
        res.json({ success: false, error: error.message });
    }
});

app.put('/auto-message-settings/:id', requireLogin, async (req, res) => {
    try {
        console.log("PUT request data:", req.body);
        
        // Önce mevcut ayarları alıp, güncelleme yapacağız
        const existingSettings = await userOperations.getAutoMessageSettings(req.session.userId);
        const currentSetting = existingSettings.find(s => s.id === parseInt(req.params.id));
        
        if (!currentSetting) {
            throw new Error("Güncellenecek ayar bulunamadı");
        }
        
        // Gelen verilerle mevcut verileri birleştir
        const settings = {
            userId: req.session.userId,
            groupId: req.body.groupId || currentSetting.group_id,
            excelFileId: req.body.excelFileId || currentSetting.excel_file_id,
            scheduleType: req.body.scheduleType || currentSetting.schedule_type,
            // Eğer scheduleType daily ise scheduleTime'ı al, değilse varsayılan değer
            scheduleTime: req.body.scheduleType === 'daily' ? 
                           (req.body.scheduleTime || currentSetting.schedule_time) : 
                           (currentSetting.schedule_time || '00:00'),
            // Eğer scheduleType hourly ise intervalHours'ı al, değilse varsayılan değer
            intervalHours: req.body.scheduleType === 'hourly' ? 
                           parseInt(req.body.intervalHours || currentSetting.interval_hours || 1) : 
                           1,
            // Eğer scheduleType minute ise intervalMinutes'ı al, değilse varsayılan değer
            intervalMinutes: req.body.scheduleType === 'minute' ? 
                             parseInt(req.body.intervalMinutes || currentSetting.interval_minutes || 5) : 
                             5
        };

        console.log('Güncellenen otomatik mesaj ayarları:', settings);
        await userOperations.updateAutoMessageSettings(req.params.id, settings);
        
        // Zamanlamayı güncelle
        scheduleMessageSending(req.session.userId, req.params.id);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating auto message settings:', error);
        res.json({ success: false, error: error.message });
    }
});

app.delete('/auto-message-settings/:id', requireLogin, async (req, res) => {
    try {
        await userOperations.deleteAutoMessageSettings(req.params.id, req.session.userId);
        
        // Varolan zamanlamayı iptal et
        if (scheduledJobs[`${req.session.userId}_${req.params.id}`]) {
            scheduledJobs[`${req.session.userId}_${req.params.id}`].cancel();
            delete scheduledJobs[`${req.session.userId}_${req.params.id}`];
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting auto message settings:', error);
        res.json({ success: false, error: error.message });
    }
});

// Start server
http.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 