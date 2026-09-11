-- dashboard_agregado.sql
-- Agrega o Dashboard dentro do Postgres em vez de baixar as linhas para o app.
--
-- Antes: /api/dashboard baixava ate 20.000 linhas de `logs` + todas as linhas de
-- `conferencia_recebimentos` do periodo (9 colunas) so para somar em Python.
-- Depois: uma unica chamada que devolve ~1 KB ja agregado.
--
-- Rode este arquivo inteiro no SQL Editor do Supabase.

-- 1) Indice que sustenta o filtro por periodo (logs ja tem idx_logs_created).
create index if not exists idx_conf_receb_recebido_em
  on public.conferencia_recebimentos (recebido_em);

-- 2) A funcao.
create or replace function public.dashboard_agregado(
  p_ini      timestamptz,
  p_fim      timestamptz,
  p_usuario  text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with termo as (
  select nullif(btrim(coalesce(p_usuario, '')), '') as t
),
receb as (
  select
    coalesce(nullif(btrim(coalesce(r.operador, '')), ''), '—') as operador,
    coalesce(r.quantidade, 0)                                  as quantidade,
    nullif(btrim(coalesce(r.order_id, '')), '')                as order_id
  from public.conferencia_recebimentos r
  cross join termo
  where r.recebido_em >= p_ini
    and r.recebido_em <= p_fim
    and (termo.t is null or r.operador ilike '%' || termo.t || '%')
),
receb_op as (
  select
    operador,
    coalesce(sum(quantidade), 0)::bigint as pecas,
    count(distinct order_id)::bigint     as pedidos_tocados
  from receb
  group by operador
),
lg as (
  select
    coalesce(nullif(btrim(coalesce(l.usuario, '')), ''), '—') as operador,
    btrim(coalesce(l.tipo_acao, ''))                          as tipo_acao
  from public.logs l
  cross join termo
  where l.created_at >= p_ini
    and l.created_at <= p_fim
    and (termo.t is null or l.usuario ilike '%' || termo.t || '%')
),
log_op as (
  select
    operador,
    count(*) filter (
      where tipo_acao in (
        'FINALIZACAO_OK', 'FINALIZACAO_AGENDADO', 'FINALIZACAO_CORRIGIDA'
      )
    )::bigint as finalizacoes,
    count(*) filter (where tipo_acao = 'IMPRESSAO')::bigint as impressoes
  from lg
  group by operador
),
ops as (
  select operador from receb_op
  union
  select operador from log_op
),
consolidado as (
  select
    o.operador,
    coalesce(r.pecas, 0)::bigint           as pecas,
    coalesce(r.pedidos_tocados, 0)::bigint as pedidos_tocados,
    coalesce(l.finalizacoes, 0)::bigint    as finalizacoes,
    coalesce(l.impressoes, 0)::bigint      as impressoes
  from ops o
  left join receb_op r using (operador)
  left join log_op   l using (operador)
)
select jsonb_build_object(
  'por_operador',
  coalesce(
    (
      select jsonb_agg(
        to_jsonb(c)
        order by c.pecas desc, c.finalizacoes desc, lower(c.operador)
      )
      from consolidado c
    ),
    '[]'::jsonb
  ),
  'pedidos_distintos',
  (select count(distinct order_id) from receb)
);
$$;

-- 3) Permissoes.
grant execute on function public.dashboard_agregado(timestamptz, timestamptz, text)
  to anon, authenticated, service_role;

-- Teste rapido (hoje, em Brasilia):
--   select public.dashboard_agregado(
--     (current_date::timestamp at time zone 'America/Sao_Paulo'),
--     ((current_date + 1)::timestamp at time zone 'America/Sao_Paulo') - interval '1 microsecond',
--     null
--   );
