import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import fs from 'fs';

/**
 * Browser context oluşturur
 */
async function createBrowserContext() {
  try {
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-extensions',
        '--disable-background-networking'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      ignoreHTTPSErrors: true
    });

    // Browser'ın düzgün başladığından emin ol
    await new Promise(resolve => setTimeout(resolve, 1000));

    return { browser, context };
  } catch (error) {
    console.error('Browser başlatma hatası:', error.message);
    throw error;
  }
}

/**
 * Flashscore sitesinden maç verilerini çeker
 */
async function fetchFlashscoreData(url) {
  let browser;
  let context;
  let page;

  try {
    const browserContext = await createBrowserContext();
    browser = browserContext.browser;
    context = browserContext.context;
    page = await context.newPage();

    // Sayfaya git ve yüklenmesini bekle
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 120000
    });

    // Sayfanın tam yüklenmesi için biraz bekle
    await page.waitForTimeout(2000);

    // Sayfanın yüklenmesini bekle
    await page.waitForSelector('#detail', { timeout: 60000 });

    // Maç tarihini kontrol et - eğer maç başlamadıysa null döndür
    let matchTime;
    try {
      matchTime = await page.locator(
        '#detail > div.duelParticipant__container > div.duelParticipant > div.duelParticipant__startTime > div'
      ).first().textContent();
      if (matchTime) matchTime = matchTime.trim();
      
      // Skor değerlerini kontrol et - eğer skorlar boşsa maç başlamamış demektir
      try {
        const homeScore = await page.locator(
          '#detail > div.duelParticipant__container > div.duelParticipant > div.duelParticipant__score > div > div.detailScore__wrapper > span:nth-child(1)'
        ).first().textContent();
        const homeScoreTrimmed = homeScore ? homeScore.trim() : '';
        
        // Eğer skor boşsa veya sadece "-" ise, maç başlamamış
        if (!homeScoreTrimmed || homeScoreTrimmed === '-' || homeScoreTrimmed === '') {
          console.log(`⏸️  Maç henüz başlamadı (Tarih: ${matchTime || 'Bilinmiyor'})`);
          return null; // Maç başlamadı, null döndür
        }
      } catch (scoreError) {
        // Skor alanı bulunamazsa, maç başlamamış olabilir
        console.log(`⏸️  Skor alanı bulunamadı, maç henüz başlamamış olabilir (Tarih: ${matchTime || 'Bilinmiyor'})`);
        return null;
      }
    } catch (error) {
      // Tarih selector'ı bulunamazsa skor kontrolü yap
      try {
        const homeScore = await page.locator(
          '#detail > div.duelParticipant__container > div.duelParticipant > div.duelParticipant__score > div > div.detailScore__wrapper > span:nth-child(1)'
        ).first().textContent();
        const homeScoreTrimmed = homeScore ? homeScore.trim() : '';
        
        if (!homeScoreTrimmed || homeScoreTrimmed === '-' || homeScoreTrimmed === '') {
          console.log(`⏸️  Maç henüz başlamadı (Skor yok)`);
          return null;
        }
      } catch (scoreError) {
        // Her iki kontrol de başarısızsa devam et (maç başlamış olabilir)
        console.log('⚠️  Maç durumu kontrol edilemedi, devam ediliyor...');
      }
    }

    // Maç durumunu kontrol et - eğer maç bittiyse null döndür
    try {
      const matchStatus = await page.locator(
        '#detail > div.duelParticipant__container > div.duelParticipant > div.duelParticipant__score > div > div.detailScore__status > span'
      ).first().textContent();
      
      if (matchStatus) {
        const statusTrimmed = matchStatus.trim();
        if (statusTrimmed === 'Finished' || statusTrimmed.toLowerCase() === 'finished') {
          console.log(`🏁 Maç bitti (Durum: ${statusTrimmed}), Excel'e veri eklenmeyecek`);
          return null; // Maç bitti, null döndür
        }
      }
    } catch (statusError) {
      // Durum selector'ı bulunamazsa devam et (maç devam ediyor olabilir)
      console.log('⚠️  Maç durumu okunamadı, devam ediliyor...');
    }

    // Verileri çek - selector'ları daha esnek hale getir
    let homeTeam;
    try {
      homeTeam = await page.locator(
        '#detail > div.duelParticipant__container > div.duelParticipant > div.duelParticipant__home > div.participant__participantNameWrapper > div.participant__participantName.participant__overflow > a'
      ).first().textContent();
      if (homeTeam) homeTeam = homeTeam.trim();
    } catch {
      // Alternatif selector dene
      try {
        homeTeam = await page.locator('div.duelParticipant__home a.participant__participantName').first().textContent();
        if (homeTeam) homeTeam = homeTeam.trim();
      } catch {
        throw new Error('Home team bulunamadı');
      }
    }

    const homeScore = await page.locator(
      '#detail > div.duelParticipant__container > div.duelParticipant > div.duelParticipant__score > div > div.detailScore__wrapper > span:nth-child(1)'
    ).first().textContent();
    const homeScoreTrimmed = homeScore ? homeScore.trim() : '';

    // Away team selector'ı daha esnek yap (winner class olmayabilir)
    let awayTeam;
    try {
      awayTeam = await page.locator(
        '#detail > div.duelParticipant__container > div.duelParticipant > div.duelParticipant__away.duelParticipant--winner > div.participant__participantNameWrapper > div.participant__participantName.participant__overflow > a'
      ).first().textContent();
      if (awayTeam) awayTeam = awayTeam.trim();
    } catch {
      try {
        awayTeam = await page.locator(
          '#detail > div.duelParticipant__container > div.duelParticipant > div.duelParticipant__away > div.participant__participantNameWrapper > div.participant__participantName.participant__overflow > a'
        ).first().textContent();
        if (awayTeam) awayTeam = awayTeam.trim();
      } catch {
        throw new Error('Away team bulunamadı');
      }
    }

    const awayScore = await page.locator(
      '#detail > div.duelParticipant__container > div.duelParticipant > div.duelParticipant__score > div > div.detailScore__wrapper > span:nth-child(3)'
    ).first().textContent();
    const awayScoreTrimmed = awayScore ? awayScore.trim() : '';

    return {
      source: 'Flashscore',
      homeTeam,
      homeScore: homeScoreTrimmed,
      awayTeam,
      awayScore: awayScoreTrimmed
    };
  } catch (error) {
    const errorMsg = error.message || error.toString() || 'Bilinmeyen hata';
    console.error('Flashscore veri çekme hatası:', errorMsg);
    throw new Error(errorMsg);
  } finally {
    // Browser'ı kapatmadan önce biraz bekle
    await new Promise(resolve => setTimeout(resolve, 500));

    if (page) {
      try {
        await page.close().catch(() => { });
      } catch (e) {
        // Sayfa zaten kapanmış olabilir
      }
    }

    if (context) {
      try {
        await context.close().catch(() => { });
      } catch (e) {
        // Context zaten kapanmış olabilir
      }
    }

    if (browser) {
      try {
        await browser.close().catch(() => { });
      } catch (e) {
        // Browser zaten kapanmış olabilir
      }
    }
  }
}

/**
 * Scoreleo sitesinden maç verilerini çeker
 */
async function fetchScoreleoData(url) {
  let browser;
  let context;
  let page;

  try {
    const browserContext = await createBrowserContext();
    browser = browserContext.browser;
    context = browserContext.context;
    page = await context.newPage();

    // Scoreleo için daha esnek bir yaklaşım - sayfa yüklenene kadar bekle
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 120000
    });

    // Sayfanın JavaScript ile yüklenmesini bekle
    await page.waitForTimeout(5000); // 5 saniye bekle

    // Selector'ların yüklenmesini bekle (daha uzun timeout)
    await page.waitForSelector('.home-team', { timeout: 60000 });

    // Verileri çek
    const homeTeam = await page.locator('.home-team').first().textContent();
    const homeTeamTrimmed = homeTeam ? homeTeam.trim() : '';

    const homeScore = await page.locator('.home-team-score').first().textContent();
    const homeScoreTrimmed = homeScore ? homeScore.trim() : '';

    const awayTeam = await page.locator('.away-team').first().textContent();
    const awayTeamTrimmed = awayTeam ? awayTeam.trim() : '';

    const awayScore = await page.locator('.away-team-score').first().textContent();
    const awayScoreTrimmed = awayScore ? awayScore.trim() : '';

    return {
      source: 'Scoreleo',
      homeTeam: homeTeamTrimmed,
      homeScore: homeScoreTrimmed,
      awayTeam: awayTeamTrimmed,
      awayScore: awayScoreTrimmed
    };
  } catch (error) {
    const errorMsg = error.message || error.toString() || 'Bilinmeyen hata';
    console.error('Scoreleo veri çekme hatası:', errorMsg);
    throw new Error(errorMsg);
  } finally {
    // Browser'ı kapatmadan önce biraz bekle
    await new Promise(resolve => setTimeout(resolve, 500));

    if (page) {
      try {
        await page.close().catch(() => { });
      } catch (e) {
        // Sayfa zaten kapanmış olabilir
      }
    }

    if (context) {
      try {
        await context.close().catch(() => { });
      } catch (e) {
        // Context zaten kapanmış olabilir
      }
    }

    if (browser) {
      try {
        await browser.close().catch(() => { });
      } catch (e) {
        // Browser zaten kapanmış olabilir
      }
    }
  }
}

/**
 * Her iki siteden veri çeker ve karşılaştırır
 */
async function fetchMatchData(flashscoreUrl, scoreleoUrl) {
  console.log('Veriler çekiliyor...\n');

  try {
    // Her iki siteden paralel olarak veri çek
    // Her site için ayrı browser instance kullan (daha güvenilir)
    // Scoreleo timeout sorunu olabilir, bu yüzden Promise.allSettled kullanıyoruz
    const [flashscoreResult, scoreleoResult] = await Promise.allSettled([
      fetchFlashscoreData(flashscoreUrl),
      fetchScoreleoData(scoreleoUrl)
    ]);

    // Sonuçları kontrol et
    const flashscoreData = flashscoreResult.status === 'fulfilled'
      ? flashscoreResult.value
      : {
        error: flashscoreResult.reason?.message ||
          flashscoreResult.reason?.toString() ||
          'Bilinmeyen hata'
      };

    // Eğer Flashscore null döndüyse (maç başlamadı), null döndür
    if (flashscoreData === null) {
      console.log('⏸️  Maç henüz başlamadı, Excel\'e veri eklenmeyecek');
      return null;
    }

    const scoreleoData = scoreleoResult.status === 'fulfilled'
      ? scoreleoResult.value
      : {
        error: scoreleoResult.reason?.message ||
          scoreleoResult.reason?.toString() ||
          'Bilinmeyen hata'
      };

    // Sonuçları göster
    console.log('=== FLASHSCORE VERİLERİ ===');
    if (flashscoreData.error) {
      console.log('Hata:', flashscoreData.error);
    } else {
      console.log('Ev Sahibi Takım:', flashscoreData.homeTeam);
      console.log('Ev Sahibi Skor:', flashscoreData.homeScore);
      console.log('Rakip Takım:', flashscoreData.awayTeam);
      console.log('Rakip Skor:', flashscoreData.awayScore);
    }
    console.log('');

    console.log('=== SCORELEO VERİLERİ ===');
    if (scoreleoData.error) {
      console.log('Hata:', scoreleoData.error);
    } else {
      console.log('Ev Sahibi Takım:', scoreleoData.homeTeam);
      console.log('Ev Sahibi Skor:', scoreleoData.homeScore);
      console.log('Rakip Takım:', scoreleoData.awayTeam);
      console.log('Rakip Skor:', scoreleoData.awayScore);
    }
    console.log('');

    // Verileri JSON formatında da döndür
    return {
      flashscore: flashscoreData,
      scoreleo: scoreleoData
    };
  } catch (error) {
    console.error('Genel hata:', error.message);
    throw error;
  }
}

/**
 * Sonuçları Excel dosyasına export eder
 */
async function exportToExcel(data, matchName) {
  // files klasörünü oluştur (yoksa)
  const filesDir = 'files';
  if (!fs.existsSync(filesDir)) {
    fs.mkdirSync(filesDir, { recursive: true });
  }

  // Dosya adını maç adından oluştur (özel karakterleri temizle)
  const safeFileName = matchName.replace(/[<>:"/\\|?*]/g, '_').trim();
  const filename = `${filesDir}/${safeFileName}.xlsx`;
  const workbook = new ExcelJS.Workbook();

  let worksheet;
  let isNewFile = true;

  // Mevcut dosyayı kontrol et ve oku
  try {
    if (fs.existsSync(filename)) {
      await workbook.xlsx.readFile(filename);
      worksheet = workbook.getWorksheet('Match Data Comparison');

      // Eğer worksheet yoksa yeni oluştur
      if (!worksheet) {
        worksheet = workbook.addWorksheet('Match Data Comparison');
        isNewFile = true;
      } else {
        isNewFile = false;
      }
    } else {
      worksheet = workbook.addWorksheet('Match Data Comparison');
      isNewFile = true;
    }
  } catch (error) {
    // Dosya okunamazsa yeni oluştur
    console.error('Excel dosyası okuma hatası:', error.message);
    worksheet = workbook.addWorksheet('Match Data Comparison');
    isNewFile = true;
  }

  // Eğer yeni dosya ise veya başlık satırı yoksa başlıkları ekle
  if (isNewFile || worksheet.rowCount === 0) {
    // Başlık satırını ekle (array olarak)
    const headerRow = worksheet.addRow([
      'Site',
      'Home Team',
      'Home Score',
      'Away Team',
      'Away Score',
      'Update Time',
      'Status'
    ]);

    // Başlık stilini ayarla
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };

    // Kolon genişliklerini ayarla
    worksheet.getColumn(1).width = 15; // Site
    worksheet.getColumn(2).width = 25; // Ev Sahibi Takım
    worksheet.getColumn(3).width = 15; // Ev Sahibi Skor
    worksheet.getColumn(4).width = 25; // Rakip Takım
    worksheet.getColumn(5).width = 15; // Rakip Skor
    worksheet.getColumn(6).width = 25; // Güncelleme Zamanı
    worksheet.getColumn(7).width = 15; // Durum
  }

  // Yeni veri için boş satır ekle (eğer dosya zaten varsa ve başlık dışında satır varsa)
  if (!isNewFile && worksheet.rowCount > 1) {
    worksheet.addRow(['', '', '', '', '', '', '']); // Boş satır - kayıtlar arası ayırıcı
  }

  // Skorları karşılaştır (farklı olanları kırmızı yapmak için)
  let homeScoreDifferent = false;
  let awayScoreDifferent = false;

  if (!data.flashscore.error && !data.scoreleo.error) {
    // Skorları normalize et (trim, boşlukları temizle)
    const flashscoreHomeScore = String(data.flashscore.homeScore || '').trim();
    const flashscoreAwayScore = String(data.flashscore.awayScore || '').trim();
    const scoreleoHomeScore = String(data.scoreleo.homeScore || '').trim();
    const scoreleoAwayScore = String(data.scoreleo.awayScore || '').trim();

    // Skorları karşılaştır
    homeScoreDifferent = flashscoreHomeScore !== scoreleoHomeScore &&
      flashscoreHomeScore !== '' &&
      scoreleoHomeScore !== '';
    awayScoreDifferent = flashscoreAwayScore !== scoreleoAwayScore &&
      flashscoreAwayScore !== '' &&
      scoreleoAwayScore !== '';

    // Debug için konsola yazdır
    if (homeScoreDifferent || awayScoreDifferent) {
      console.log('\n⚠️ SKOR FARKI TESPİT EDİLDİ:');
      console.log(`Flashscore: ${flashscoreHomeScore}-${flashscoreAwayScore}`);
      console.log(`Scoreleo: ${scoreleoHomeScore}-${scoreleoAwayScore}`);
    }
  }

  const fetchTime = new Date().toLocaleString('tr-TR');

  // Flashscore verileri
  let flashscoreRow;
  if (data.flashscore.error) {
    flashscoreRow = worksheet.addRow([
      'Flashscore',
      '-',
      '-',
      '-',
      '-',
      '-',
      'Hata: ' + data.flashscore.error
    ]);
  } else {
    flashscoreRow = worksheet.addRow([
      'Flashscore',
      data.flashscore.homeTeam || '',
      data.flashscore.homeScore || '',
      data.flashscore.awayTeam || '',
      data.flashscore.awayScore || '',
      fetchTime,
      'Başarılı'
    ]);

    // Skorlar farklıysa sadece Flashscore satırını kırmızı yap
    if (homeScoreDifferent || awayScoreDifferent) {
      flashscoreRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFF0000' }
      };
      flashscoreRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    }
  }

  // Scoreleo verileri
  let scoreleoRow;
  if (data.scoreleo.error) {
    scoreleoRow = worksheet.addRow([
      'Scoreleo',
      '-',
      '-',
      '-',
      '-',
      '-',
      'Hata: ' + data.scoreleo.error
    ]);
  } else {
    scoreleoRow = worksheet.addRow([
      'Scoreleo',
      data.scoreleo.homeTeam || '',
      data.scoreleo.homeScore || '',
      data.scoreleo.awayTeam || '',
      data.scoreleo.awayScore || '',
      fetchTime,
      'Başarılı'
    ]);
    // Scoreleo satırı renklendirilmiyor - sadece Flashscore renklendiriliyor
  }

  // Sadece yeni eklenen satırları hizala (Flashscore ve Scoreleo satırları)
  const rowsToAlign = [];
  if (flashscoreRow) rowsToAlign.push(flashscoreRow);
  if (scoreleoRow) rowsToAlign.push(scoreleoRow);

  rowsToAlign.forEach(row => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
  });

  // Başlık satırı için border ekle (sadece yeni dosya oluşturulduğunda)
  if (isNewFile) {
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
  }

  // Excel dosyasını kaydet (aynı dosya adıyla)
  await workbook.xlsx.writeFile(filename);

  if (isNewFile) {
    console.log(`\n✅ Yeni Excel dosyası oluşturuldu: ${filename}`);
  } else {
    console.log(`\n✅ Yeni sonuçlar mevcut Excel dosyasına eklendi: ${filename}`);
  }

  return filename;
}

/**
 * data.json dosyasından maçları okur
 */
function loadMatches() {
  try {
    const data = fs.readFileSync('data.json', 'utf8');
    const jsonData = JSON.parse(data);
    return jsonData.matches || [];
  } catch (error) {
    console.error('❌ data.json dosyası okunamadı:', error.message);
    return [];
  }
}

/**
 * Tek bir maç için veri çekme ve Excel'e kaydetme işlemini gerçekleştirir
 */
async function processMatch(match) {
  try {
    console.log(`\n📊 Maç: ${match.name}`);
    console.log(`   Flashscore: ${match.flashscore}`);
    console.log(`   Scoreleo: ${match.scoreleo}`);

    const data = await fetchMatchData(match.flashscore, match.scoreleo);

    // Eğer maç başlamadıysa (data null), Excel'e yazma
    if (data === null) {
      console.log(`⏸️  Maç henüz başlamadı, Excel'e veri eklenmeyecek: ${match.name}`);
      return;
    }

    console.log('\n=== JSON ÇIKTISI ===');
    console.log(JSON.stringify(data, null, 2));

    // Excel'e export et
    try {
      const filename = await exportToExcel(data, match.name);
      console.log(`\n✅ Sonuçlar başarıyla Excel dosyasına kaydedildi: ${filename}`);
    } catch (excelError) {
      console.error(`\n❌ Excel export hatası (${match.name}):`, excelError.message);
    }
  } catch (error) {
    console.error(`\n❌ Maç işleme hatası (${match.name}):`, error.message);
  }
}

/**
 * Tüm maçları kontrol eder ve Excel'e kaydeder
 */
async function runCheckAndSave() {
  try {
    const matches = loadMatches();

    if (matches.length === 0) {
      console.log('⚠️  data.json dosyasında maç bulunamadı!');
      return;
    }

    console.log(`\n[${new Date().toLocaleString('tr-TR')}] ${matches.length} maç kontrol ediliyor...`);

    // Her maç için ayrı işlem yap (sıralı olarak, paralel değil - browser kaynaklarını korumak için)
    for (const match of matches) {
      await processMatch(match);
      // Maçlar arasında kısa bir bekleme ekle
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(`\n✅ Tüm maçlar işlendi (${matches.length} maç)`);
  } catch (error) {
    console.error(`\n[${new Date().toLocaleString('tr-TR')}] Genel hata:`, error.message);
  }
}

// İlk kontrolü hemen yap
console.log('🚀 Maç verisi kontrol sistemi başlatıldı');
console.log('⏱️  Her 30 saniyede bir kontrol yapılacak');
console.log('📁 Her maç için ayrı Excel dosyası oluşturulacak');
console.log('⏹️  Durdurmak için Ctrl+C tuşlarına basın\n');

runCheckAndSave();

// Her 30 saniyede bir kontrol yap
const interval = setInterval(() => {
  runCheckAndSave();
}, 30000); // 30 saniye = 30000 milisaniye

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n⏹️  Sistem durduruluyor...');
  clearInterval(interval);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n⏹️  Sistem durduruluyor...');
  clearInterval(interval);
  process.exit(0);
});


