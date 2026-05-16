-- =============================================
-- 약품 공유 게시판 v2 · Supabase 설정 SQL
-- ※ 기존 테이블 초기화 시 먼저 실행:
--    drop table if exists drug_likes, drug_versions, drugs, manufacturers, profiles cascade;
-- =============================================

-- ── 1. 사용자 프로필 ──────────────────────────
create table if not exists public.profiles (
  id            uuid references auth.users(id) on delete cascade primary key,
  pharmacy_name text not null default '익명약국',
  region        text,
  created_at    timestamptz default now()
);

-- ── 2. 제약사 마스터 ──────────────────────────
create table if not exists public.manufacturers (
  id          uuid default gen_random_uuid() primary key,
  name        text not null unique,
  website_url text,
  logo_url    text,
  created_at  timestamptz default now()
);

-- 주요 제약사 초기 데이터
insert into public.manufacturers (name, website_url) values
  ('동아제약',   'https://www.donga.co.kr'),
  ('한미약품',   'https://www.hanmi.co.kr'),
  ('종근당',     'https://www.ckdpharm.com'),
  ('유한양행',   'https://www.yuhan.co.kr'),
  ('보령제약',   'https://www.boryung.co.kr'),
  ('광동제약',   'https://www.kwangdong.co.kr'),
  ('한국얀센',   'https://www.janssen.com/korea'),
  ('GSK',        'https://www.gsk.com/ko-kr'),
  ('기타',       null)
on conflict (name) do nothing;

-- ── 3. 약품 마스터 ────────────────────────────
create table if not exists public.drugs (
  id                uuid default gen_random_uuid() primary key,
  created_at        timestamptz default now(),
  canonical_name    text not null,
  manufacturer_id   uuid references public.manufacturers(id),
  manufacturer_name text not null default '기타',
  category          text not null default '기타',
  func_tags         text[] default '{}',
  emoji             text default '💊',
  version_count     int default 0,
  total_downloads   int default 0,
  best_version_id   uuid
);

-- ── 4. 약품 버전 ──────────────────────────────
create table if not exists public.drug_versions (
  id               uuid default gen_random_uuid() primary key,
  created_at       timestamptz default now(),
  drug_id          uuid references public.drugs(id) on delete cascade not null,
  user_id          uuid references auth.users(id) on delete cascade not null,
  pharmacy_name    text default '익명약국',
  image_url        text,
  image_url_2      text,
  image_url_3      text,
  efficacy         text not null,
  dosage           text not null,
  pharmacist_note  text,
  downloads_count  int default 0
);

-- =============================================
-- RLS
-- =============================================
alter table public.profiles      enable row level security;
alter table public.manufacturers enable row level security;
alter table public.drugs         enable row level security;
alter table public.drug_versions enable row level security;

create policy "profiles_select" on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update" on public.profiles for update using (auth.uid() = id);

create policy "mfr_select" on public.manufacturers for select using (true);
create policy "mfr_insert" on public.manufacturers for insert with check (auth.role() = 'authenticated');

create policy "drugs_select" on public.drugs for select using (true);
create policy "drugs_insert" on public.drugs for insert with check (auth.role() = 'authenticated');
create policy "drugs_update" on public.drugs for update using (true);

create policy "versions_select" on public.drug_versions for select using (true);
create policy "versions_insert" on public.drug_versions for insert with check (auth.uid() = user_id);
create policy "versions_update" on public.drug_versions for update using (auth.uid() = user_id);
create policy "versions_delete" on public.drug_versions for delete using (auth.uid() = user_id);

-- =============================================
-- 트리거: 회원가입 시 프로필 자동 생성
-- =============================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, pharmacy_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'pharmacy_name', '익명약국'))
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =============================================
-- 트리거: 버전 변경 시 drugs 집계 자동 갱신
-- =============================================
create or replace function public.update_drug_stats()
returns trigger as $$
declare
  v_drug_id uuid;
begin
  if TG_OP = 'DELETE' then v_drug_id := OLD.drug_id;
  else v_drug_id := NEW.drug_id;
  end if;

  update public.drugs set
    version_count   = (select count(*) from public.drug_versions where drug_id = v_drug_id),
    total_downloads = (select coalesce(sum(downloads_count),0) from public.drug_versions where drug_id = v_drug_id),
    best_version_id = (select id from public.drug_versions where drug_id = v_drug_id order by downloads_count desc limit 1)
  where id = v_drug_id;

  return coalesce(NEW, OLD);
end;
$$ language plpgsql security definer;

drop trigger if exists on_version_change on public.drug_versions;
create trigger on_version_change
  after insert or update or delete on public.drug_versions
  for each row execute procedure public.update_drug_stats();

-- =============================================
-- Storage 버킷
-- =============================================
insert into storage.buckets (id, name, public)
values ('drug-images', 'drug-images', true)
on conflict (id) do nothing;

create policy "images_select" on storage.objects for select using (bucket_id = 'drug-images');
create policy "images_insert" on storage.objects for insert with check (bucket_id = 'drug-images' and auth.role() = 'authenticated');
create policy "images_delete" on storage.objects for delete using (bucket_id = 'drug-images' and auth.uid()::text = (storage.foldername(name))[1]);

-- =============================================
-- 다운로드 카운트 증가 RPC (동시성 safe)
-- =============================================
create or replace function increment_version_downloads(p_version_id uuid)
returns void as $$
begin
  update public.drug_versions set downloads_count = downloads_count + 1 where id = p_version_id;
end;
$$ language plpgsql security definer;
