-- ============================================================
-- Hi English - Supabase 数据表结构
-- 在 Supabase Studio → SQL Editor 中粘贴执行本文件
-- ============================================================

-- 1. 学习数据表：每个学员一行，data 为完整学习记录(JSONB)
--    empid 即学员工号（如 gw00147407 / 100256）
CREATE TABLE IF NOT EXISTS study_data (
  empid      TEXT PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_data_updated ON study_data(updated_at);

-- 2. 应用配置表：users / admin / groups / messages / dingtalk / beta
--    每个配置文件一行（key 即文件名，不含 .json）
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_config_updated ON app_config(updated_at);

-- 说明：
-- 1) service_role key 自动绕过 RLS，无需额外策略即可读写。
-- 2) 若日后开启 RLS，请添加 policy 允许 service_role 全权访问这两张表。
-- 3) 写入额度：每个学员每次保存 = study_data 表 1 行 UPSERT；
--    200 学员 × 每天数次 × 30 天 ≈ 几千~1万行，免费层(5万行/月)足够。
