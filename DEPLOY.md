# Rukible — yayına alma

## İlk kurulum (bir kez)

### 1. Vercel'e giriş

```bash
npx vercel login
```

E-posta sorar, tarayıcıda onaylarsın.

### 2. Projeyi oluştur ve ilk deploy

```bash
npx vercel
```

Sorulara verilecek cevaplar:

| Soru | Cevap |
|---|---|
| Set up and deploy? | **y** |
| Which scope? | kendi hesabın |
| Link to existing project? | **n** |
| Project name? | `rukible` (enter'a basarsan klasör adı olur) |
| In which directory is your code? | **./** (enter) |
| Modify settings? | **n** |

Sonunda bir önizleme adresi verir. Henüz çalışmaz — ortam değişkenleri eksik.

### 3. Ortam değişkenlerini gir

**Panelden gir, terminalden değil** — terminale yazarsan komut geçmişine kaydolur.

`https://vercel.com/dashboard` → projen → **Settings** → **Environment Variables**

Her biri için "Production", "Preview" ve "Development" kutularının üçünü de işaretle:

| Anahtar | Değer |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter anahtarın (`sk-or-v1-…`) |
| `SUPABASE_SERVICE_KEY` | Supabase service_role anahtarın |
| `APP_PASSWORD` | **Güçlü bir şifre belirle** — araca giriş için |
| `SESSION_SECRET` | Oturum çerezini imzalar. Üret: `openssl rand -hex 32` |

İsteğe bağlı: `MODEL` (varsayılan `moonshotai/kimi-k3`).

> `APP_PASSWORD` ya da `SESSION_SECRET` tanımlı değilse araç bilerek açılmaz.
> Bu, "şifre koymayı unutup interneti açık bırakma" ihtimalini ortadan
> kaldırmak için.
>
> `SESSION_SECRET`'i değiştirmek tüm oturumları anında geçersiz kılar — çerezi
> çalınan biri olursa acil "herkesi çıkart" düğmen budur.

### 4. Canlıya al

```bash
npx vercel --prod
```

Verdiği adres artık gerçek adresin. Paylaşım linkleri de bu adresle çalışır:
`https://<adresin>/p/<kod>`

---

## Sonraki güncellemeler

Kodda değişiklik yaptıktan sonra tek komut:

```bash
npx vercel --prod
```

---

## Kontrol listesi

- [ ] Araca girerken şifre soruyor mu?
- [ ] Yanlış şifre reddediliyor mu?
- [ ] Sayfa üretimi çalışıyor mu?
- [ ] Düzenleme (yamalı mod) çalışıyor mu?
- [ ] Versiyon geçmişinden geri dönülüyor mu?
- [ ] Paylaşım linki **başka bir cihazdan** (telefon, mobil veri) açılıyor mu?
- [ ] Paylaşım linki şifre sormuyor, doğrudan açılıyor mu?

---

## Bilinen sınırlar

**Süre.** Vercel ücretsiz planında bir istek en fazla 300 saniye sürebilir.
Bizim sayfa üretimi ~180 saniye. Çok karmaşık isteklerde zaman aşımı görürsen
`lib/config.ts` içindeki `MAX_OUTPUT_TOKENS` değerini düşür.

**Erişim.** Şifre tek ve paylaşımlı. Birden fazla kişi kullanacaksa ve kimin ne
yaptığını ayırt etmek gerekiyorsa gerçek kullanıcı girişi eklenmeli.
