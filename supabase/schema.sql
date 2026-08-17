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
