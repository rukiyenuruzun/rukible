-- Rukible veritabanı şeması
--
-- Supabase panelinde SQL Editor'ü aç, bu dosyanın tamamını yapıştır ve çalıştır.
-- https://supabase.com/dashboard/project/wbgaumyggausjwyluecq/sql/new

-- Bir proje = üzerinde çalıştığın bir sayfa ("Kampanya sayfası" gibi).
create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'Adsız proje',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Her üretim ve her düzenleme ayrı bir versiyon olarak saklanır.
-- Geri alma böyle çalışır: eski versiyonu seçmen yeterli, hiçbir şey silinmez.
create table if not exists versions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  html        text not null,
  prompt      text,                 -- bu versiyonu üreten istek
  cost        numeric,              -- bu üretimin dolar maliyeti
  share_slug  text unique,          -- doluysa bu versiyon herkese açık
  created_at  timestamptz not null default now()
);

create index if not exists versions_project_idx
  on versions (project_id, created_at desc);

create index if not exists projects_updated_idx
  on projects (updated_at desc);

-- Güvenlik: RLS açık ve hiçbir politika tanımlı değil.
-- Yani anon (tarayıcı) anahtarıyla bu tablolara erişilemez.
-- Sunucumuzun kullandığı service_role anahtarı RLS'i baypas eder,
-- dolayısıyla tüm erişim bizim API rotalarımızdan geçmek zorunda.
alter table projects enable row level security;
alter table versions enable row level security;
