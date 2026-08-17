-- Avalor 的服务端 schema。
--
-- 这里存的东西极少，而且是刻意的：牌局数据留在浏览器的 IndexedDB 里，
-- 不上云。加一个 AI 按钮不该把本地优先这个卖点推翻。
--
-- 所以服务端只回答两个问题：你是谁，你还能不能再调一次 AI。
--
-- 用法：Supabase 后台 → SQL Editor → 整段贴进去跑一次。可以重复跑。

-- ---------------------------------------------------------------------------
-- profiles：每个注册用户一行，白名单标记就挂在这
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  -- 内测白名单。默认 false —— 注册不等于能用 AI，得你在后台手动勾。
  ai_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 用户只能读自己那行。写入一律走 service role（只有服务端拿得到），
-- 所以这里故意没有 insert / update / delete 策略 —— 没有策略就是全部拒绝。
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- 注册时自动建 profile。security definer 才能写受 RLS 保护的表；
-- search_path 置空是防搜索路径劫持的标准写法。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- ai_usage：每次调用一行。既是限流的依据，也是账单的对账凭据
-- ---------------------------------------------------------------------------

create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  task text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  -- 按调用当时的单价算好存下来。单价会变，历史账不该跟着变。
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);

-- 两个查询各一个索引：某人今天调了几次、本月全站花了多少。
create index if not exists ai_usage_user_time
  on public.ai_usage (user_id, created_at desc);
create index if not exists ai_usage_time
  on public.ai_usage (created_at desc);

alter table public.ai_usage enable row level security;

drop policy if exists "read own usage" on public.ai_usage;
create policy "read own usage" on public.ai_usage
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- game_backups：登录用户主动上传的对局备份
--
-- 是「备份」，不是「同步」：上传是把这台设备的版本推上去，恢复是把云端的
-- 拉下来。双向合并要处理两台设备同时改同一局的冲突，那是另一个量级的工程，
-- 而用户真正怕的是「换手机记录没了」—— 备份就解决了。
--
-- 一局一行，整份导出 JSON 存在 payload 里。复用的正是导出功能那个已经带
-- 版本号、带校验、有测试覆盖的格式，所以云端和本地文件是同一种东西。
-- ---------------------------------------------------------------------------

create table if not exists public.game_backups (
  user_id uuid not null references auth.users on delete cascade,
  -- 本地那局的 id 原样带上来，所以重复上传是覆盖，不会越备越多。
  game_id uuid not null,
  payload jsonb not null,
  -- 冗余出来只为列表页显示，不用把整个 payload 拉下来才知道有几局。
  player_count int,
  event_count int,
  game_created_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

create index if not exists game_backups_user_time
  on public.game_backups (user_id, game_created_at desc);

alter table public.game_backups enable row level security;

-- 四条策略都要有：这张表是浏览器直接读写的（走 anon key），
-- 不像 ai_usage 那样只有服务端碰。RLS 是这里唯一的边界。
drop policy if exists "read own backups" on public.game_backups;
create policy "read own backups" on public.game_backups
  for select using (auth.uid() = user_id);

drop policy if exists "write own backups" on public.game_backups;
create policy "write own backups" on public.game_backups
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own backups" on public.game_backups;
create policy "update own backups" on public.game_backups
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own backups" on public.game_backups;
create policy "delete own backups" on public.game_backups
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 开白名单：把邮箱换成内测用户的，跑一行
-- ---------------------------------------------------------------------------
--
--   update public.profiles set ai_enabled = true
--   where email = 'someone@example.com';
--
-- 也可以直接在 Table Editor 里勾。五个人的规模不值得写管理后台。
--
-- 看本月花了多少：
--
--   select round(sum(cost_usd), 2) as usd, count(*) as calls
--   from public.ai_usage
--   where created_at >= date_trunc('month', now());
