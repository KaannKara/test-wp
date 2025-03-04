const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

// Veritabanı bağlantısını oluştur
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
    if (err) {
        console.error('Veritabanı bağlantı hatası:', err);
    } else {
        console.log('Veritabanına bağlanıldı');
        initializeDatabase();
    }
});

// Veritabanı tablolarını oluştur
function initializeDatabase() {
    db.serialize(() => {
        // Kullanıcılar tablosu
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error('Error creating users table:', err);
            } else {
                console.log('Users table checked/created');
            }
        });

        // WhatsApp oturumları tablosu
        db.run(`CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_data TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Gönderilen mesajlar tablosu
        db.run(`CREATE TABLE IF NOT EXISTS sent_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            group_id TEXT NOT NULL,
            message TEXT NOT NULL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )`);

        // WhatsApp grupları tablosu
        db.run(`CREATE TABLE IF NOT EXISTS whatsapp_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            group_id TEXT NOT NULL,
            group_name TEXT NOT NULL,
            participant_count INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, group_id)
        )`);

        // Excel dosyaları tablosu
        db.run(`CREATE TABLE IF NOT EXISTS excel_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )`, (err) => {
            if (err) {
                console.error('Error creating excel_files table:', err);
            } else {
                console.log('Excel files table checked/created');
            }
        });

        // Otomatik mesaj ayarları tablosu
        db.run(`CREATE TABLE IF NOT EXISTS auto_message_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            group_id TEXT NOT NULL,
            excel_file_id INTEGER NOT NULL,
            schedule_type TEXT NOT NULL,
            schedule_time TEXT,
            interval_hours INTEGER,
            interval_minutes INTEGER,
            last_sent_at DATETIME,
            next_send_at DATETIME,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id),
            FOREIGN KEY (excel_file_id) REFERENCES excel_files (id)
        )`, (err) => {
            if (err) {
                console.error('Error creating auto_message_settings table:', err);
            } else {
                console.log('Auto message settings table checked/created');
                
                // Eğer interval_minutes sütunu yoksa ekle
                db.all("PRAGMA table_info(auto_message_settings)", (err, rows) => {
                    if (err) {
                        console.error('Error checking table schema:', err);
                        return;
                    }
                    
                    console.log('Tablo şeması:', rows);
                    
                    // interval_minutes sütununu kontrol et, yoksa ekle
                    if (Array.isArray(rows)) {
                        const hasIntervalMinutes = rows.some(row => row.name === 'interval_minutes');
                        if (!hasIntervalMinutes) {
                            console.log('Adding interval_minutes column to auto_message_settings table');
                            // Dakika aralığı için interval_minutes sütunu ekle
                            db.run(`ALTER TABLE auto_message_settings ADD COLUMN interval_minutes INTEGER`, (err) => {
                                if (err) {
                                    console.error('Error adding interval_minutes column:', err);
                                } else {
                                    console.log('interval_minutes column added successfully');
                                }
                            });
                        } else {
                            console.log('interval_minutes column already exists');
                        }
                    } else {
                        console.error('PRAGMA sorgusu beklenen sonuç formatını vermedi, rows:', rows);
                    }
                });
            }
        });
        
        // Tabloların sütunlarını kontrol et ve gerekirse yeni sütunları ekle
        migrateDatabase();
    });
}

// Veritabanı şemasını güncelle (yeni sütunlar ekle)
function migrateDatabase() {
    // auto_message_settings tablosuna last_sent_at ve next_send_at alanlarını ekle
    db.run(`ALTER TABLE auto_message_settings ADD COLUMN last_sent_at TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('Error adding last_sent_at column:', err);
        }
    });
    
    db.run(`ALTER TABLE auto_message_settings ADD COLUMN next_send_at TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('Error adding next_send_at column:', err);
        }
    });
    
    // Dakika aralığı için interval_minutes sütunu ekle
    db.run(`ALTER TABLE auto_message_settings ADD COLUMN interval_minutes INTEGER`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('Error adding interval_minutes column:', err);
        }
    });
}

// Kullanıcı işlemleri
const userOperations = {
    // Yeni kullanıcı oluştur
    createUser: async (username, email, password) => {
        const hashedPassword = await bcrypt.hash(password, 10);
        return new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
                [username, email, hashedPassword],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.lastID);
                    }
                }
            );
        });
    },

    // Kullanıcı girişi kontrol et
    verifyUser: async (email, password) => {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM users WHERE email = ?',
                [email],
                async (err, user) => {
                    if (err) {
                        reject(err);
                    } else if (!user) {
                        resolve(null);
                    } else {
                        const match = await bcrypt.compare(password, user.password);
                        resolve(match ? user : null);
                    }
                }
            );
        });
    },

    // Kullanıcı bilgilerini getir
    getUserById: (id) => {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT id, username, email, created_at FROM users WHERE id = ?',
                [id],
                (err, user) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(user);
                    }
                }
            );
        });
    },

    // WhatsApp oturumu kaydet/güncelle
    saveWhatsAppSession: (userId, sessionData) => {
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO whatsapp_sessions (user_id, session_data) 
                 VALUES (?, ?) 
                 ON CONFLICT(user_id) 
                 DO UPDATE SET session_data = ?, updated_at = CURRENT_TIMESTAMP`,
                [userId, sessionData, sessionData],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.lastID);
                    }
                }
            );
        });
    },

    // WhatsApp oturumunu getir
    getWhatsAppSession: (userId) => {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT session_data FROM whatsapp_sessions WHERE user_id = ?',
                [userId],
                (err, session) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(session ? session.session_data : null);
                    }
                }
            );
        });
    },

    // Mesaj kaydı ekle
    logMessage: (userId, groupId, message) => {
        return new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO sent_messages (user_id, group_id, message) VALUES (?, ?, ?)',
                [userId, groupId, message],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.lastID);
                    }
                }
            );
        });
    },

    // Kullanıcının mesaj geçmişini getir
    getMessageHistory: (userId) => {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM sent_messages WHERE user_id = ? ORDER BY sent_at DESC',
                [userId],
                (err, messages) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(messages);
                    }
                }
            );
        });
    }
};

// WhatsApp Grupları için fonksiyonlar
async function saveWhatsAppGroups(userId, groups) {
    // Önce eski grupları kaldır
    return new Promise((resolve, reject) => {
        // Tüm mevcut grupları pasif yap
        db.run('DELETE FROM whatsapp_groups WHERE user_id = ?', [userId], (err) => {
            if (err) {
                return reject(err);
            }
            
            // Yeni grupları ekle - Promise zinciri oluşturarak sırayla ekle
            let insertPromise = Promise.resolve();
            for (const group of groups) {
                insertPromise = insertPromise.then(() => {
                    return new Promise((resolveInsert, rejectInsert) => {
                        db.run(
                            `INSERT INTO whatsapp_groups 
                            (user_id, group_id, group_name, participant_count, updated_at) 
                            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                            [userId, group.id, group.name, group.participantsCount],
                            (err) => {
                                if (err) {
                                    rejectInsert(err);
                                } else {
                                    resolveInsert();
                                }
                            }
                        );
                    });
                });
            }
            
            // Tüm ekleme işlemleri tamamlandığında
            insertPromise
                .then(() => resolve())
                .catch(err => reject(err));
        });
    });
}

async function getWhatsAppGroups(userId) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT * FROM whatsapp_groups WHERE user_id = ?',
            [userId],
            (err, groups) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(groups);
                }
            }
        );
    });
}

// Excel dosyaları için fonksiyonlar
async function saveExcelFile(fileData) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO excel_files (user_id, file_name, file_path, is_active) 
             VALUES (?, ?, ?, 1)`,
            [fileData.userId, fileData.originalName, fileData.filePath],
            function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            }
        );
    });
}

async function getExcelFiles(userId) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT id, file_name as original_name, file_path FROM excel_files WHERE user_id = ? AND is_active = 1',
            [userId],
            (err, files) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(files);
                }
            }
        );
    });
}

async function deleteExcelFile(fileId, userId) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE excel_files SET is_active = 0 WHERE id = ? AND user_id = ?',
            [fileId, userId],
            function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes > 0);
                }
            }
        );
    });
}

// Otomatik mesaj ayarları için fonksiyonlar
async function saveAutoMessageSettings(settings) {
    return new Promise((resolve, reject) => {
        try {
            console.log("saveAutoMessageSettings çağrıldı:", JSON.stringify(settings, null, 2));
            
            // Parametreleri kontrol et
            if (!settings.user_id) {
                throw new Error("user_id parametresi gerekli");
            }
            
            if (!settings.group_id) {
                throw new Error("group_id parametresi gerekli");
            }
            
            if (!settings.excel_file_id) {
                throw new Error("excel_file_id parametresi gerekli");
            }
            
            if (!settings.schedule_type) {
                throw new Error("schedule_type parametresi gerekli");
            }
            
            // Sonraki gönderim zamanını hesapla
            let nextSendAt = new Date();
            const now = new Date();
            
            try {
                if (settings.schedule_type === 'daily') {
                    // Günlük gönderim için
                    if (!settings.schedule_time) {
                        throw new Error("Günlük program için schedule_time gerekli");
                    }
                    
                    const [hour, minute] = settings.schedule_time.split(':');
                    nextSendAt = new Date();
                    nextSendAt.setHours(parseInt(hour, 10), parseInt(minute, 10), 0, 0);
                    
                    if (nextSendAt <= now) {
                        nextSendAt.setDate(nextSendAt.getDate() + 1);
                    }
                    
                    console.log(`Günlük program için sonraki gönderim: ${nextSendAt.toLocaleString('tr-TR')}`);
                } else if (settings.schedule_type === 'hourly') {
                    // Saatlik gönderim için
                    if (!settings.interval_hours) {
                        throw new Error("Saatlik program için interval_hours gerekli");
                    }
                    
                    const hours = parseInt(settings.interval_hours, 10);
                    nextSendAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
                    
                    console.log(`Saatlik program için sonraki gönderim: ${nextSendAt.toLocaleString('tr-TR')}`);
                } else if (settings.schedule_type === 'minute') {
                    // Dakikalık gönderim için
                    if (!settings.interval_minutes) {
                        throw new Error("Dakikalık program için interval_minutes gerekli");
                    }
                    
                    const minutes = parseInt(settings.interval_minutes, 10);
                    nextSendAt = new Date(now.getTime() + minutes * 60 * 1000);
                    
                    console.log(`Dakikalık program için sonraki gönderim: ${nextSendAt.toLocaleString('tr-TR')}`);
                } else {
                    throw new Error(`Bilinmeyen program tipi: ${settings.schedule_type}`);
                }
            } catch (timeError) {
                console.error(`Tarih hesaplama hatası: ${timeError.message}`);
                console.error('Varsayılan değer kullanılıyor: 1 saat sonra');
                nextSendAt = new Date(now.getTime() + 60 * 60 * 1000);
            }
            
            // Zamanın geçerli olduğunu kontrol et
            if (isNaN(nextSendAt.getTime())) {
                console.error('Geçersiz tarih oluştu, şimdi + 1 saat kullanılıyor');
                nextSendAt = new Date(now.getTime() + 60 * 60 * 1000);
            }
            
            const nextSendAtStr = nextSendAt.toISOString();
            console.log(`Veritabanına kaydedilecek tarih: ${nextSendAtStr}`);
            
            // Veritabanına kaydet
            db.run(`
                INSERT INTO auto_message_settings (
                    user_id, group_id, excel_file_id, schedule_type, 
                    schedule_time, interval_hours, interval_minutes, next_send_at, is_active
                ) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
            `, [
                settings.user_id,
                settings.group_id,
                settings.excel_file_id,
                settings.schedule_type,
                settings.schedule_time,
                settings.interval_hours,
                settings.interval_minutes,
                nextSendAtStr
            ], function(err) {
                if (err) {
                    console.error('Otomatik mesaj ayarı kaydetme hatası:', err);
                    reject(err);
                } else {
                    console.log(`Otomatik mesaj ayarı kaydedildi, ID: ${this.lastID}`);
                    resolve(this.lastID);
                }
            });
        } catch (error) {
            console.error('saveAutoMessageSettings fonksiyonunda hata:', error);
            reject(error);
        }
    });
}

async function getAutoMessageSettings(userId) {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT ams.id, ams.user_id, ams.group_id, ams.excel_file_id, 
                   ams.schedule_type, ams.schedule_time, ams.interval_hours,
                   ams.last_sent_at, ams.next_send_at, ams.interval_minutes,
                   ef.file_name as excel_file_name, wg.group_name
            FROM auto_message_settings ams
            JOIN excel_files ef ON ef.id = ams.excel_file_id
            JOIN whatsapp_groups wg ON wg.group_id = ams.group_id AND wg.user_id = ams.user_id
            WHERE ams.user_id = ? AND ams.is_active = 1
        `, [userId],
            (err, settings) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(settings);
                }
            }
        );
    });
}

async function updateAutoMessageSettings(id, settings) {
    return new Promise((resolve, reject) => {
        console.log("updateAutoMessageSettings çağrıldı:", {id, settings});
        
        try {
            // Önce settings parametrelerini kontrol et
            if (!id) {
                throw new Error("ID parametresi gerekli");
            }
            
            if (!settings.userId) {
                throw new Error("userId parametresi gerekli");
            }
            
            if (!settings.groupId) {
                throw new Error("groupId parametresi gerekli");
            }
            
            if (!settings.excelFileId) {
                throw new Error("excelFileId parametresi gerekli");
            }
            
            if (!settings.scheduleType) {
                throw new Error("scheduleType parametresi gerekli");
            }
            
            const nextSendAt = calculateNextSendTime(
                settings.scheduleType, 
                settings.scheduleTime, 
                settings.intervalHours, 
                settings.intervalMinutes
            );
            
            console.log("SQL sorgusu için parametreler:", {
                groupId: settings.groupId,
                excelFileId: settings.excelFileId,
                scheduleType: settings.scheduleType,
                scheduleTime: settings.scheduleTime,
                intervalHours: settings.intervalHours,
                nextSendAt: nextSendAt ? nextSendAt.toISOString() : null,
                intervalMinutes: settings.intervalMinutes,
                id: id,
                userId: settings.userId
            });
            
            db.run(`
                UPDATE auto_message_settings 
                SET group_id = ?, excel_file_id = ?, schedule_type = ?, schedule_time = ?, interval_hours = ?, next_send_at = ?, interval_minutes = ?
                WHERE id = ? AND user_id = ?
            `, [
                settings.groupId, 
                settings.excelFileId, 
                settings.scheduleType, 
                settings.scheduleTime, 
                settings.intervalHours, 
                nextSendAt ? nextSendAt.toISOString() : null,
                settings.intervalMinutes,
                id, 
                settings.userId
            ], function(err) {
                if (err) {
                    console.error('Error updating auto message settings:', err);
                    reject(err);
                } else {
                    console.log(`Auto message settings updated for ID ${id}, changes: ${this.changes}`);
                    resolve(this.changes);
                }
            });
        } catch (error) {
            console.error('Exception in updateAutoMessageSettings:', error);
            reject(error);
        }
    });
}

// Sonraki gönderim zamanını hesaplayan yardımcı fonksiyon
function calculateNextSendTime(scheduleType, scheduleTime, intervalHours, intervalMinutes) {
    console.log('calculateNextSendTime çağrıldı:', {
        scheduleType,
        scheduleTime,
        intervalHours,
        intervalMinutes
    });
    
    const now = new Date();
    let nextSendAt = new Date();
    
    try {
        if (scheduleType === 'daily') {
            // Günlük zamanlama için saat ve dakika ayarları
            if (!scheduleTime || typeof scheduleTime !== 'string' || !scheduleTime.includes(':')) {
                throw new Error(`Geçersiz scheduleTime değeri: ${scheduleTime}`);
            }
            
            const [hour, minute] = scheduleTime.split(':');
            nextSendAt.setHours(parseInt(hour, 10), parseInt(minute, 10), 0, 0);
            
            if (nextSendAt <= now) {
                nextSendAt.setDate(nextSendAt.getDate() + 1);
            }
            
            console.log(`Günlük zamanlama - Sonraki gönderim: ${nextSendAt.toLocaleString('tr-TR')}`);
        } else if (scheduleType === 'hourly') {
            // Saatlik zamanlama
            if (!intervalHours || isNaN(parseInt(intervalHours, 10))) {
                throw new Error(`Geçersiz intervalHours değeri: ${intervalHours}`);
            }
            
            const hours = parseInt(intervalHours, 10);
            nextSendAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
            
            console.log(`Saatlik zamanlama - Sonraki gönderim: ${nextSendAt.toLocaleString('tr-TR')}`);
        } else if (scheduleType === 'minute') {
            // Dakikalık zamanlama
            let minutes = 5; // Varsayılan değer
            
            if (intervalMinutes !== null && intervalMinutes !== undefined) {
                minutes = parseInt(intervalMinutes, 10);
                
                if (isNaN(minutes) || minutes <= 0) {
                    console.warn(`Geçersiz intervalMinutes değeri: ${intervalMinutes}, varsayılan 5 dakika kullanılıyor`);
                    minutes = 5;
                }
            } else {
                console.warn('intervalMinutes değeri tanımlanmamış, varsayılan 5 dakika kullanılıyor');
            }
            
            nextSendAt = new Date(now.getTime() + minutes * 60 * 1000);
            
            console.log(`Dakikalık zamanlama - Aralık: ${minutes} dakika, Sonraki gönderim: ${nextSendAt.toLocaleString('tr-TR')}`);
        } else {
            throw new Error(`Bilinmeyen zamanlama tipi: ${scheduleType}`);
        }
        
        // Sonuç tarihin geçerli olduğundan emin ol
        if (isNaN(nextSendAt.getTime())) {
            throw new Error('Hesaplanan tarih geçersiz');
        }
        
        console.log(`Hesaplanan sonraki gönderim zamanı: ${nextSendAt.toLocaleString('tr-TR')}`);
        return nextSendAt;
    } catch (error) {
        console.error(`Sonraki gönderim zamanı hesaplanırken hata: ${error.message}`);
        console.error('Hata ayrıntıları:', error);
        console.error('Varsayılan zaman kullanılıyor: 1 saat sonra');
        
        // Hata durumunda 1 saat sonrası için varsayılan bir değer döndür
        return new Date(now.getTime() + 60 * 60 * 1000);
    }
}

// Mesaj gönderildikten sonra zamanlama bilgilerini güncelle
async function updateAutoMessageTimings(id, lastSentAt, nextSendAt) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE auto_message_settings 
             SET last_sent_at = ?, next_send_at = ?
             WHERE id = ?`,
            [lastSentAt, nextSendAt, id],
            function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            }
        );
    });
}

// Sadece sonraki gönderim zamanını güncelle
async function updateNextSendTime(id, nextSendAt) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE auto_message_settings 
             SET next_send_at = ?
             WHERE id = ?`,
            [nextSendAt, id],
            function(err) {
                if (err) {
                    console.error('Sonraki gönderim zamanı güncellenirken hata:', err);
                    reject(err);
                } else {
                    console.log(`Sonraki gönderim zamanı güncellendi (ID: ${id}): ${nextSendAt}`);
                    resolve(this.changes);
                }
            }
        );
    });
}

async function deleteAutoMessageSettings(id, userId) {
    return new Promise((resolve, reject) => {
        db.run(`
            UPDATE auto_message_settings
            SET is_active = 0
            WHERE id = ? AND user_id = ?
        `, [id, userId],
            function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes > 0);
                }
            }
        );
    });
}

module.exports = {
    ...userOperations,
    saveWhatsAppGroups,
    getWhatsAppGroups,
    saveExcelFile,
    getExcelFiles,
    deleteExcelFile,
    saveAutoMessageSettings,
    getAutoMessageSettings,
    updateAutoMessageSettings,
    updateAutoMessageTimings,
    updateNextSendTime,
    deleteAutoMessageSettings
}; 