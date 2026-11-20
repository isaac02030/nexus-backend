# Relatório do Codex

## Feito
- Criados `docs/conselho/decisoes.md` e `docs/conselho/agentes.md` com as instruções fornecidas para o conselho do Nexus.
- O emparelhamento automático no backend agora exige `MATCHING_ENABLED=true`; sem essa configuração, permanece desligado.
- O frontend só consulta pares quando o backend informa que o interruptor está ligado e informa quando a procura está desligada.
- Commit `8b0cc18` enviado ao branch `codex/nexus-council-and-matching-switch`.

## Pendente
- Abrir pull requests para revisão; nada foi mesclado em `main`.
- Aplicar a migração ao banco somente quando houver um ambiente de banco autorizado.

## Dúvidas
- Nenhuma nesta etapa.

## Feito em 18/11/2026 — backup do banco

- Não existe `AGENTS.md` neste repositório. A tarefa seguiu `docs/conselho/decisoes.md`.
- `.gitignore` para Node: dependências, `.env` e variantes, logs, dumps de backup e arquivos de sistema. `env.example` continua versionado.
- O `JWT_SECRET` de exemplo deixou de ser um texto aproveitável e passou a ser o placeholder `troque-por-um-segredo-longo-e-aleatorio`.
- Scripts `npm run db:backup` e `npm run db:restore`, com `pg_dump` / `pg_restore` e `DATABASE_URL` vinda do ambiente. Os dumps ficam em `backups/`, pasta ignorada pelo Git.
- Guia em português: `docs/backup.md`. Backup automático de produção ficou só documentado, sem implementação.
- Prova local, num Postgres descartável que depois foi apagado: migração `database.sql`, uma linha fictícia, backup, banco apagado, banco vazio recriado, restauração, e a linha voltou. Uma segunda restauração desfez uma alteração feita depois do backup. O mesmo teste também passou com `DATABASE_URL` no formato `postgresql://usuario:senha@127.0.0.1:5432/banco`. A senha não apareceu na saída. Nada disso foi commitado (nem o dump, nem senha, nem a linha de teste).

## Pendente nesta etapa
- Backup automático em produção.
- Nada foi mesclado em `main`. Railway não foi alterado.

## Feito em 18/11/2026 — horário do lembrete

- Migration `migrations/002_user_reminder.sql`: colunas `reminder_time` e `timezone` em `users`, as duas podem ficar vazias. Rodar de novo não apaga dado.
- Rotas `GET` e `PUT /api/users/me/reminder`, com login. Horário inválido ou fuso inválido responde 400 em português.
- Quem escolhe um horário recebe esse lembrete todo dia, se a missão estiver ativa. Os outros dois avisos têm alvo 13:00 e 20:30, só entre 09:00 e 21:30, a pelo menos 2 horas do horário principal e um do outro, e só saem se o check-in de hoje, no fuso da pessoa, ainda não foi feito. Quem não escolheu horário continua no comportamento antigo.
- Esses avisos são só push. Não entram no chat e não contam no limite de conversas com a IA.
- Em desenvolvimento, o CORS aceita `http://localhost:8080`. Com `NODE_ENV=production`, esse endereço não entra.
- Prova local num Postgres descartável: a migration rodou duas vezes, o PUT/GET funcionou com login e recusou horário e fuso ruins, e `npm test` passou (11 testes). O padrão dos dois horários extras está no pull request para o dono confirmar.
- Nada foi mesclado em `main`. Railway não foi alterado.

## Feito em 19/11/2026 — acesso à missão

- O placar só é lido por quem ainda é `user_id` ou `partner_id`. Quem não participa recebe 404, o mesmo corpo de missão inexistente.
- Check-in, progresso, sequência, detalhe, lista e mensagens deixam de tratar check-in ou mensagem antiga como participação. Escrever check-in ou mensagem exige missão ativa.
- Quem já participa e a missão não está ativa continua recebendo a recusa de missão inativa.
- Oito testes em `test/checkins-access.test.js` passaram com `node --test`.

## Pendente nesta correção
- Assistente da missão: já exige participante atual e ainda aceita missão encerrada.
- Notificações de check-in e de mensagem: já exigem participante atual e não checam se a missão está ativa.
- Missões de comunidade: ranking e check-in ativo foram tratados na seção seguinte.
- A rotina que preenche `partner_id` vazio a partir do histórico continua valendo quando o modo ainda é parceiro ou rival.
- Nada foi mesclado em `main`.

## Dúvidas nesta correção
- Nenhuma.

## Feito em 19/11/2026 — ranking e check-in da comunidade
- O ranking só abre para quem está em `community_mission_participants`. Quem não participa recebe 404, o mesmo corpo de missão inexistente.
- O check-in da comunidade exige missão `active`. Se não estiver, a recusa é 400: «Missão não está ativa.».
- Participante de missão ativa continua fazendo check-in. Solo, Duo e Rival não mudaram. Sem schema nem migração.
- Testes novos em `test/community-missions-access.test.js`. `node --test` passou.

## Feito em 20/11/2026 — dia da missão no fuso da pessoa

- O conteúdo do horário do lembrete (PR 2) foi trazido para esta branch. O script de teste continua `node --test`.
- O número do dia e o corte do fim da missão usam o fuso da pessoa, o mesmo da hora do aviso. Quem não escolheu horário continua no cálculo antigo.
- A migração `002_user_reminder.sql` não foi alterada. Na codex só existia a `001`, então não houve conflito de número.
- Testes novos: meia-noite em fusos diferentes, último dia da missão, e a rota do lembrete com banco simulado. `node --test`: 31 passaram, 1 pulado (o teste antigo de Postgres real, que não rodou).
- Nada foi mesclado em `main`.

## Feito em 20/11/2026 — dias difíceis de novo, em cima do fuso

- O conteúdo do PR 3 voltou num branch novo, em cima do lembrete com fuso. O placar e o check-in continuam só para dono ou parceiro atual. Check-in ou mensagem antiga não devolve acesso.
- Cada pessoa tem 4 dias difíceis na missão, no máximo 2 seguidos. O dia difícil continua concluído e passa pela mesma prova do check-in. A conta é por pessoa.
- A contagem e a gravação do dia difícil ficam na mesma transação, com `SELECT ... FOR UPDATE` na missão.
- O número do dia do check-in usa o fuso da pessoa quando o horário do aviso também está escolhido. Fuso vazio continua no relógio do servidor.
- Migração `003_checkin_difficult_day.sql` só acrescenta `is_difficult`, padrão falso. A ordem no `database.sql` é 001, 002, 003.
- `node --test`: 51 passaram, 1 pulado (o Postgres real do lembrete, que não rodou).
- A janela de dias seguidos olha os dois lados. O dia do check-in é calculado depois da trava. O check-in comum usa a mesma transação do dia difícil.
- Nada foi mesclado em `main`. O PR 3 antigo permanece aberto.
