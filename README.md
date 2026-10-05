# Direciona.Ai 🏥

Assistente de WhatsApp **gratuito** que ajuda as pessoas a saber **onde buscar atendimento no SUS**: UBS, UPA 24h, Pronto-Socorro, SAMU 192, CAPS ou maternidade.

A pessoa conta o que está sentindo (por texto ou áudio). O bot faz algumas perguntas rápidas e diz qual serviço procurar. Também pode mostrar a unidade mais próxima e tirar dúvidas sobre saúde e sobre o SUS.

> ⚠️ **O Direciona.Ai não faz diagnóstico nem indica remédio.** É uma orientação inicial e não substitui avaliação profissional. Em emergência, ligue **192**.

---

## ✨ O que o bot faz

- **Triagem por WhatsApp**, por texto ou áudio. O áudio é transcrito e segue o mesmo fluxo do texto.
- **Emergências vão direto ao SAMU 192**, com orientação de primeiros socorros: dor no peito, falta de ar, sinais de AVC, convulsão, pessoa desacordada, acidente grave, queimadura elétrica/química/extensa, intoxicação, reação alérgica grave, glicose baixa grave, pensamentos suicidas (encaminha ao **CVV 188**) e outras.
- **Orientação de destino**: UBS, UPA, CAPS ou maternidade, com os sinais que devem fazer a pessoa voltar ou ligar 192.
- **Unidade mais próxima**: a pessoa envia a localização ou o bairro e cidade.
- **Dúvidas de saúde e SUS**: respostas com base numa base de conhecimento curada, com mais de 140 tópicos.
- **Memória da conversa**: lembra fatos importantes, como idade, gestação e doenças crônicas.
- **Resposta em áudio** para quem mandou áudio. O texto chega na hora e o áudio curto vem logo depois.
- **Privacidade (LGPD)**: o comando `apagar` remove os dados da pessoa. O número de telefone é guardado só como hash.

### Comandos no WhatsApp

| Mensagem | O que faz |
|---|---|
| `início`, `menu`, `recomeçar`, `/reset` | Começa um novo atendimento |
| `apagar` | Apaga os dados e o histórico da pessoa |
| Enviar localização 📎 | Busca UPA, UBS ou hospital mais próximo |

---

## 🧠 Como funciona

Toda mensagem (texto, áudio ou API) passa pelo mesmo caminho:

```
Mensagem
   │
   ▼
[1] Guarda crítica (regex) ── pegou emergência óbvia? ──► SAMU/CVV na hora (sem esperar o LLM)
   │
   ▼
[2] Reformulou 3x? ── sim ──► encaminha para o Disque Saúde 136 / 192
   │
   ▼
[3] LLM decisor (Groq) ── falhou? ──► fallback determinístico (regras fixas)
   │   decide: emergencia | perguntar | orientar | responder_rag | conversa | fora_escopo
   │
   ├─ responder_rag ──► busca na base de conhecimento (pgvector) ──► LLM redige
   ▼
[4] Validação final
   │   • piso de segurança: se há critério crítico, nunca fica abaixo de emergência
   │   • piso de UPA: acidente recente, queimadura com bolha/área nobre/grupo de risco,
   │     choque elétrico, dor de cabeça + nuca + febre, dente arrancado, nariz que não
   │     para de sangrar, quase afogamento; dor + atraso menstrual → maternidade
   │   • emergência sempre usa texto aprovado (não o texto do LLM)
   │   • texto com diagnóstico ou remédio é trocado
   ▼
Resposta + estado salvo + log estruturado
```

**Princípio de segurança:** o LLM decide a conversa, mas **nunca é a única barreira**. A guarda roda antes dele, a validação roda depois, e o bot continua funcionando se o LLM cair.

---

## 🛠️ Tecnologias

- **Node.js 20+** e **TypeScript**
- **WhatsApp**: [Baileys](https://github.com/WhiskeySockets/Baileys)
- **LLM**: [Groq](https://groq.com) (padrão `llama-3.3-70b-versatile`) para decisão e redação
- **Transcrição de áudio**: Groq Whisper
- **Voz (TTS) e embeddings**: Google Gemini
- **Banco**: Supabase/Postgres com `pgvector` (sessão, estado das conversas e busca na base)
- **Mapas**: base local do CNES → OpenStreetMap (Overpass) → Google Places (opcional)
- **API**: Express
- **Testes**: Vitest

---

## 📁 Estrutura

```
src/
├── index.ts                  # servidor Express (/health, /qr, /api) + inicia o bot
├── whatsapp/
│   ├── bot.ts                # recebe mensagens, áudio, localização, comandos
│   ├── persistencia_sessao.ts# sessão do WhatsApp no banco
│   └── persistencia_estado.ts# estado das conversas no banco
├── ia/
│   ├── orquestrador.ts       # o fluxo completo de um turno
│   ├── guarda_critica.ts     # detecção de emergência + protocolos de primeiros socorros
│   ├── decisor.ts            # prompt e schema do LLM decisor
│   ├── validacao_final.ts    # checagens de segurança depois do LLM
│   ├── fallback.ts           # triagem sem LLM
│   ├── memoria.ts            # fatos do usuário + detecção de reformulação
│   ├── acidente.ts           # regras de acidente de trânsito
│   ├── base_conhecimento.ts  # busca (RAG) e redação das respostas educativas
│   ├── motor_de_regras.ts    # regras fixas de destino (usado no fallback)
│   └── __tests__/            # testes
├── regras/                   # JSON de regras + base_conhecimento.json
├── respostas/                # mensagens aprovadas (textos fixos)
├── servicos/                 # Groq, Gemini (TTS/embeddings), mapas, logs, métricas
├── atendimento/atendimento.ts # a conversa (comandos, áudio, localização, triagem): WhatsApp e app
├── api/rotas.ts              # API do app (chat, áudio, localização) + /api/metricas
└── scripts/sincronizar_base.ts # envia a base de conhecimento para o Supabase
dados/unidades_saude.json     # unidades do CNES (Niterói e Rio de Janeiro)
processar_cnes.mjs            # gera dados/unidades_saude.json a partir do CNES
```

---

## 🚀 Rodando localmente

**Pré-requisitos:** Node.js 20 ou mais e um banco Postgres com `pgvector` (o Supabase serve).

```bash
git clone https://github.com/Aishabrito/back.direciona.git
cd back.direciona
npm install
cp .env.example .env      # preencha as chaves
npm run dev
```

Abra `http://localhost:3000/qr` e escaneie o QR Code com o WhatsApp que vai ser o bot (**Aparelhos conectados → Conectar um aparelho**).

> 💡 Use um **número dedicado** para o bot. O Baileys não é a API oficial do WhatsApp, e existe risco de bloqueio do número.

### Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `GROQ_API_KEY` | ✅ | LLM decisor e transcrição de áudio |
| `DATABASE_URL` | ✅ | Supabase/Postgres (sessão, estado, busca vetorial) |
| `GEMINI_API_KEY` | recomendada | Resposta em áudio e embeddings da base |
| `PUBLIC_URL` | recomendada | Endereço público (link do QR Code) |
| `GROQ_MODEL` | opcional | Troca o modelo do Groq |
| `GROQ_WHISPER_MODEL` | opcional | Troca o modelo de transcrição |
| `METRICAS_TOKEN` | opcional | Liga o `/api/metricas` |
| `GOOGLE_PLACES_API_KEY` | opcional | Fallback na busca de unidades |
| `UNIDADES_JSON` | opcional | Outro arquivo de unidades de saúde |
| `PORT` | opcional | Porta do servidor (padrão 3000) |

Sem `GROQ_API_KEY` o bot **continua funcionando**, mas só com as regras fixas, sem o LLM.

### Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Desenvolvimento com recarga automática |
| `npm run build` | Compila para `dist/` |
| `npm start` | Roda a versão compilada |
| `npm test` | Roda os testes |
| `npm run sincronizar-base` | Envia `base_conhecimento.json` para o Supabase (rode depois de editar a base) |

---

## 🧪 Testes

```bash
npm test
```

Os testes cobrem a guarda de emergência (casos que devem e que **não** devem disparar), a validação final (diagnóstico, remédio, pisos de segurança), o parser do LLM, o fluxo de conversas com o LLM simulado, acidentes de trânsito e os comandos de recomeçar.

---

## 🌐 API

`POST /api/chat`, para testar ou integrar sem WhatsApp:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "teste-1", "mensagem": "estou com febre há 4 dias"}'
```

A resposta traz `mensagens` (cada uma com `texto` e, para quem mandou áudio, `audio` em MP3/base64) e `aguardandoLocalizacao` (quando o bot ofereceu buscar a unidade mais próxima).

O app mobile ([direciona-sus](https://github.com/Aishabrito/direciona-sus)) usa o **mesmo atendimento do WhatsApp** (`src/atendimento/atendimento.ts`), com estas rotas:

| Rota | Equivale no WhatsApp a |
|---|---|
| `POST /api/chat` `{ sessionId, mensagem }` | mensagem de texto (inclusive `início`, `apagar`, `sim`, bairro e cidade) |
| `POST /api/audio` `{ sessionId, audio, mime }` | áudio (base64); a resposta volta também em áudio |
| `POST /api/localizacao` `{ sessionId, lat, lng }` | 📎 → Localização |
| `GET /api/boas-vindas` | apresentação da 1ª mensagem |

Outros endpoints:
- `GET /health`: checagem de saúde.
- `GET /qr`: QR Code para conectar o WhatsApp.
- `GET /api/metricas`: métricas. Exige o cabeçalho `x-metricas-token`.

---

## 📊 Monitoramento

Cada mensagem gera uma linha de log estruturada, que pode ser filtrada por `📊 [LOG]`:

```json
{"acao":"orientar","destino":"UPA","origem_decisao":"llm","foi_guarda_regex":false,
 "latencia_ms":1200,"llm_tokens_in":500,"llm_tokens_out":120,"validacao_alterou":false}
```

- `origem_decisao: "llm"`: o Groq decidiu.
- `"fallback"`: o LLM falhou e as regras fixas decidiram.
- `"guarda"`: foi uma emergência detectada antes do LLM.
- `validacao_alterou: true`: a validação corrigiu a decisão do LLM. Vale revisar esses casos.

**Revisão recomendada:** toda semana, leia uma amostra de conversas reais, anote os erros e ajuste o **prompt** em `src/ia/decisor.ts`, evitando acrescentar novas regex.

---

## ⚠️ Limitações conhecidas

- A base local de unidades cobre **Niterói e Rio de Janeiro**. Em outras cidades, a busca usa o OpenStreetMap, que é menos completo.
- Não há atendimento humano integrado. Quando o bot não consegue ajudar, ele encaminha para o Disque Saúde 136.
- No plano gratuito do Groq, picos de uso podem fazer algumas respostas caírem nas regras fixas.
- O conteúdo médico (base de conhecimento, protocolos e mensagens) deve ser **revisado por profissional de saúde** antes de uso amplo.

---

## 🔒 Privacidade

- O número de telefone é guardado apenas como hash.
- O comando `apagar` remove o estado e o histórico da pessoa.
- Os logs guardam só o início das mensagens (até 200 caracteres), para revisão de qualidade. Avise os participantes de testes e peça consentimento.
- Nunca faça commit do `.env` nem da pasta `auth_info_baileys/`, que guarda a sessão do WhatsApp.
