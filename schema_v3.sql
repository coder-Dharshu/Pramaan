-- ================================================================
-- PRAMAAN  schema_v3.sql
-- Run once in:  Supabase → SQL Editor → Run All
-- ================================================================

-- pgvector for semantic search (RAG)
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Drop old tables cleanly ──────────────────────────────────
DROP TABLE IF EXISTS public.law_sections   CASCADE;
DROP TABLE IF EXISTS public.court_cases    CASCADE;
DROP TABLE IF EXISTS public.evidence       CASCADE;
DROP TABLE IF EXISTS public.case_messages  CASCADE;
DROP TABLE IF EXISTS public.cases          CASCADE;
DROP TABLE IF EXISTS public.lawyers        CASCADE;
DROP TABLE IF EXISTS public.users          CASCADE;

-- ================================================================
-- 1. USERS
-- ================================================================
CREATE TABLE public.users (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone      VARCHAR(15),
  name       VARCHAR(100),
  language   VARCHAR(20)  DEFAULT 'en',
  created_at TIMESTAMPTZ  DEFAULT NOW()
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own" ON public.users FOR ALL USING (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.users (id, phone, name)
  VALUES (NEW.id, NEW.phone, COALESCE(NEW.raw_user_meta_data->>'name',''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ================================================================
-- 2. LAWYERS  (NALSA-empanelled + private)
-- ================================================================
CREATE TABLE public.lawyers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(100)  NOT NULL,
  specialization VARCHAR(100),
  bar_council_id VARCHAR(50),
  city           VARCHAR(60),
  state          VARCHAR(60),
  phone          VARCHAR(15),
  email          VARCHAR(100),
  languages      TEXT[]        DEFAULT '{"en"}',
  rating         DECIMAL(2,1)  DEFAULT 0.0,
  cases_handled  INTEGER       DEFAULT 0,
  is_available   BOOLEAN       DEFAULT true,
  is_nalsa       BOOLEAN       DEFAULT false,
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);
ALTER TABLE public.lawyers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lawyers_read" ON public.lawyers FOR SELECT USING (true);

-- ================================================================
-- 3. CASES  — full 8-agent pipeline state
-- ================================================================
CREATE TABLE public.cases (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  lawyer_id            UUID REFERENCES public.lawyers(id),
  title                VARCHAR(200)  DEFAULT 'New Case',
  -- Agent 1: Intake
  language             VARCHAR(20)   DEFAULT 'en',
  status               VARCHAR(30)   DEFAULT 'intake',
  case_type            VARCHAR(60),
  incident             TEXT,
  incident_date        VARCHAR(100),
  other_party          TEXT,
  location             VARCHAR(200),
  documents_desc       TEXT,
  desired_outcome      TEXT,
  -- Agent 3: Case prep
  key_facts            TEXT[]        DEFAULT '{}',
  strategy             TEXT,
  strength_percentage  INTEGER       DEFAULT 0,
  -- Agent 4+5: RAG results
  applicable_laws      JSONB         DEFAULT '[]',
  similar_cases        JSONB         DEFAULT '[]',
  -- Agent 6: PDF
  draft_document       TEXT,
  -- Agent 7: Comms
  notices_drafted      JSONB         DEFAULT '[]',
  -- Agent 8: Lawyer
  lawyer_notified_at   TIMESTAMPTZ,
  -- Pipeline tracking
  completed_agents     TEXT[]        DEFAULT '{}',
  agent_outputs        JSONB         DEFAULT '{}',
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);
ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cases_own" ON public.cases FOR ALL USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;$$;
CREATE TRIGGER cases_ts BEFORE UPDATE ON public.cases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ================================================================
-- 4. CASE_MESSAGES
-- ================================================================
CREATE TABLE public.case_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    UUID NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  role       VARCHAR(20) NOT NULL CHECK (role IN ('user','assistant','system')),
  content    TEXT NOT NULL,
  agent      VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.case_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messages_own" ON public.case_messages FOR ALL
  USING (EXISTS (SELECT 1 FROM public.cases c WHERE c.id = case_id AND c.user_id = auth.uid()));

-- ================================================================
-- 5. EVIDENCE  (Agent 2 — File Upload + OCR + pgvector embedding)
-- ================================================================
CREATE TABLE public.evidence (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  file_name    VARCHAR(255)  NOT NULL,
  file_size    INTEGER,
  mime_type    VARCHAR(100),
  storage_path VARCHAR(500)  NOT NULL,
  ocr_text     TEXT,
  summary      TEXT,
  embedding    vector(768),      -- Gemini text-embedding-004
  status       VARCHAR(20)   DEFAULT 'uploaded',
  created_at   TIMESTAMPTZ   DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   DEFAULT NOW()
);
ALTER TABLE public.evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "evidence_own" ON public.evidence FOR ALL USING (auth.uid() = user_id);
CREATE TRIGGER evidence_ts BEFORE UPDATE ON public.evidence
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ================================================================
-- 6. LAW_SECTIONS  (Agent 4 — SectionFinder RAG index)
-- ================================================================
CREATE TABLE public.law_sections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section     VARCHAR(120)  NOT NULL,
  act         VARCHAR(200)  NOT NULL,
  description TEXT          NOT NULL,
  full_text   TEXT,
  case_types  TEXT[]        DEFAULT '{}',
  source_url  VARCHAR(500)  DEFAULT '',
  content     TEXT          NOT NULL,   -- combined text embedded
  embedding   vector(768),
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (section, act)
);
CREATE INDEX law_emb_idx ON public.law_sections
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- ================================================================
-- 7. COURT_CASES  (Agent 5 — PrecedentFinder RAG index)
-- ================================================================
CREATE TABLE public.court_cases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(300)  NOT NULL,
  citation    VARCHAR(120)  DEFAULT '',
  year        INTEGER,
  court       VARCHAR(200),
  case_type   VARCHAR(60),
  outcome     TEXT,
  summary     TEXT          NOT NULL,
  source_url  VARCHAR(500)  DEFAULT '',
  content     TEXT          NOT NULL,
  embedding   vector(768),
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (title, citation)
);
CREATE INDEX cases_emb_idx ON public.court_cases
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- ================================================================
-- 8. STORAGE BUCKET  (evidence files)
-- ================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'evidence', 'evidence', false, 10485760,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp',
        'audio/mpeg','audio/wav','audio/webm','audio/mp4']
) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "ev_upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'evidence' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "ev_read"   ON storage.objects FOR SELECT TO authenticated
  USING  (bucket_id = 'evidence' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "ev_delete" ON storage.objects FOR DELETE TO authenticated
  USING  (bucket_id = 'evidence' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ================================================================
-- 9. pgvector MATCH FUNCTION  (called by RAG pipeline)
-- ================================================================
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding   vector(768),
  match_table       TEXT,
  match_threshold   FLOAT   DEFAULT 0.50,
  match_count       INTEGER DEFAULT 6,
  filter_case_type  TEXT    DEFAULT NULL
)
RETURNS TABLE (id UUID, content TEXT, metadata JSONB, similarity FLOAT)
LANGUAGE plpgsql AS $$
BEGIN
  IF match_table = 'law_sections' THEN
    RETURN QUERY
      SELECT ls.id,
             ls.content,
             jsonb_build_object(
               'section',    ls.section,
               'act',        ls.act,
               'source_url', ls.source_url
             ) AS metadata,
             1 - (ls.embedding <=> query_embedding) AS similarity
      FROM   public.law_sections ls
      WHERE  (filter_case_type IS NULL OR filter_case_type = ANY(ls.case_types))
        AND  (1 - (ls.embedding <=> query_embedding)) >= match_threshold
      ORDER  BY ls.embedding <=> query_embedding
      LIMIT  match_count;
  ELSE
    RETURN QUERY
      SELECT cc.id,
             cc.content,
             jsonb_build_object(
               'title',      cc.title,
               'citation',   cc.citation,
               'court',      cc.court,
               'year',       cc.year,
               'source_url', cc.source_url
             ) AS metadata,
             1 - (cc.embedding <=> query_embedding) AS similarity
      FROM   public.court_cases cc
      WHERE  (filter_case_type IS NULL OR cc.case_type = filter_case_type)
        AND  (1 - (cc.embedding <=> query_embedding)) >= match_threshold
      ORDER  BY cc.embedding <=> query_embedding
      LIMIT  match_count;
  END IF;
END;
$$;

-- ================================================================
-- 10. SEED LAWYERS
-- ================================================================
INSERT INTO public.lawyers (name,specialization,city,state,languages,rating,cases_handled,is_nalsa) VALUES
  ('Adv. Priya Sharma',   'Property & Civil',      'Delhi',      'Delhi',          '{"en","hi"}',      4.8, 127, true),
  ('Adv. Rahul Mehta',    'Consumer Protection',   'Mumbai',     'Maharashtra',    '{"en","hi","mr"}', 4.6,  98, true),
  ('Adv. Lakshmi Nair',   'Family & Matrimonial',  'Bangalore',  'Karnataka',      '{"en","kn","ta"}', 4.9, 203, true),
  ('Adv. Suresh Pandey',  'Labour & Employment',   'Lucknow',    'Uttar Pradesh',  '{"en","hi"}',      4.5, 156, true),
  ('Adv. Fatima Sheikh',  'Criminal Defense',      'Hyderabad',  'Telangana',      '{"en","hi","te"}', 4.7,  89, false),
  ('Adv. Arjun Krishnan', 'RTI & Constitutional',  'Chennai',    'Tamil Nadu',     '{"en","ta"}',      4.6,  74, true),
  ('Adv. Meena Gupta',    'Family & Domestic',     'Jaipur',     'Rajasthan',      '{"en","hi"}',      4.5,  61, true),
  ('Adv. Sanjay Patil',   'Consumer & Civil',      'Pune',       'Maharashtra',    '{"en","hi","mr"}', 4.4, 112, false);
