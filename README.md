# WhatsApp API Uygulaması

Bu uygulama, WhatsApp gruplarına otomatik mesaj gönderimi için geliştirilmiştir.

## Kurulum

```bash
npm install
```

## Başlatma

Normal başlatma (konsol kapatıldığında uygulama da kapanır):
```bash
node server.js
```

## PM2 ile Arka Planda Çalıştırma

PM2, uygulamayı arka planda servis olarak çalıştırmanıza olanak tanır.

1. PM2'yi global olarak yükleyin:
```bash
npm install -g pm2
```

2. Uygulamayı PM2 ile başlatın:
```bash
pm2 start server.js --name "whatsapp-api"
```

3. Uygulama durumunu kontrol edin:
```bash
pm2 status
```

4. Güncel yapılandırmayı kaydedin:
```bash
pm2 save
```

5. Sistem başlangıcında otomatik başlatma (Windows için):

   Windows'ta PM2'nin otomatik başlatılması için, bilgisayar açılışında `pm2-startup.ps1` dosyasını PowerShell ile çalıştırmak üzere bir görev oluşturmalısınız.

   a. Windows Görev Zamanlayıcısı'nı açın
   b. "Temel görev oluştur" seçeneğini tıklayın
   c. Görev adı: "PM2-WhatsApp"
   d. Tetikleyici: "Bilgisayar başlangıcında"
   e. Eylem: "Program başlat"
   f. Program/script: `powershell.exe`
   g. Argümanlar: `-ExecutionPolicy Bypass -File "C:\xampp\htdocs\whatsapp\whatsapp-api\pm2-startup.ps1"`
   h. Görevi tamamlayın

## Kullanım

1. Tarayıcınızdan `http://localhost:3000` adresine gidin
2. Kullanıcı hesabınızla giriş yapın
3. WhatsApp QR kodunu tarayın (tek seferlik)
4. Excel dosyanızı yükleyin
5. "Otomatik Mesaj Göndermeyi Etkinleştir" butonuna tıklayın

Sistem, her gün sabah 09:00'da Excel dosyasındaki bitiş tarihi bugün olan poliçeleri otomatik olarak WhatsApp gruplarına gönderecektir.

## Önemli Notlar

- WhatsApp bağlantısı otomatik olarak yeniden kurulacak şekilde tasarlanmıştır
- Sistemi PM2 ile çalıştırdığınızda tarayıcıyı kapatmanız veya bilgisayarı yeniden başlatmanız durumunda bile WhatsApp bağlantısı korunacaktır
- Bir kez QR kodu taradığınızda, token dosyaları sayesinde tekrar tarama ihtiyacı olmadan oturumunuz korunacaktır # test-wp
