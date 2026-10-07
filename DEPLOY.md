# Colocar o bot no ar: VPS da Hostinger + Coolify

Este guia tira o bot da Suga (que tem limite no plano gratuito) e coloca numa VPS própria, com o
**Coolify** publicando direto do GitHub, como a Suga fazia. A mesma VPS pode rodar outros projetos.

## 1. Contratar a VPS (paga com Pix)

1. Entre em **hostinger.com/br** (só o site brasileiro aceita Pix) → **VPS** → plano **KVM 1**
   (1 vCPU, 4 GB de RAM: sobra para o bot e o Coolify).
2. Escolha o período. O preço baixo vale para **12 ou 24 meses pagos de uma vez**; o mensal sai mais caro.
   Pix e boleto não parcelam e **não renovam sozinhos**: anote a data de vencimento e pague antes,
   senão a VPS é suspensa e o bot sai do ar de novo.
3. Na configuração da VPS:
   - **Sistema operacional:** procure o modelo **"Ubuntu 24.04 with Coolify"** (já vem instalado).
     Se não tiver, escolha **Ubuntu 24.04** puro e siga o passo 2b.
   - **Localização:** a mais perto do Brasil disponível (São Paulo, se aparecer).
   - Crie uma **senha de root** forte e guarde.

## 2. Abrir o Coolify

**a) Se escolheu o modelo com Coolify:** abra `http://IP-DA-VPS:8000` (o IP aparece no painel da Hostinger).

**b) Se escolheu Ubuntu puro:** no painel da Hostinger, abra o **Terminal do navegador** da VPS e rode:

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Espere terminar (uns 5 minutos) e abra `http://IP-DA-VPS:8000`.

Crie a conta de administrador logo de cara (quem abrir primeiro vira dono).

## 3. Publicar o bot

1. No Coolify: **Projects → + Add → Production → + New Resource → Public/Private Repository (GitHub App)**.
   Siga o botão para instalar o app do Coolify no GitHub e libere o repositório `back.direciona`.
2. Escolha o branch `main` e, em **Build Pack**, escolha **Dockerfile** (o arquivo já está no repositório).
3. **Porta:** `3000`.
4. **Domínio:** o Coolify sugere um endereço grátis do tipo `http://xxxx.IP.sslip.io`.
   Troque `http://` por `https://` para ganhar certificado automático.
   (Se tiver domínio próprio, aponte um registro A para o IP da VPS e use, por exemplo, `https://api.direciona.ai`.)
5. **Environment Variables:** copie as mesmas da Suga:

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | a mesma do Supabase |
   | `GROQ_API_KEY` | a mesma |
   | `GEMINI_API_KEY` | a mesma |
   | `PUBLIC_URL` | o domínio do passo 4, sem barra no final |
   | `METRICAS_TOKEN`, `GOOGLE_PLACES_API_KEY` | se usava |

6. Deixe **1 instância só** (o padrão). Duas cópias do bot brigam pela mesma sessão do WhatsApp.

## 4. Trocar de servidor sem perder o WhatsApp

A sessão do WhatsApp fica salva no Supabase, então **não precisa escanear o QR de novo**, desde que
as duas cópias nunca rodem juntas:

1. **Desligue (pause/delete) o serviço na Suga primeiro.**
2. No Coolify, clique em **Deploy**.
3. Abra `https://SEU-DOMINIO/status`. Deve mostrar `"estado": "conectado"`.
   Se mostrar `aguardando_qr`, abra `https://SEU-DOMINIO/qr` e escaneie pelo WhatsApp do bot
   (**Aparelhos conectados → Conectar um aparelho**).
4. Teste mandando uma mensagem para o bot no WhatsApp.

## 5. Apontar o app para o servidor novo

No repositório `direciona-sus`, troque o endereço em `ia/remoto.ts` (`URL_PADRAO`) pelo domínio novo,
ou defina `EXPO_PUBLIC_API_URL` no `.env` do app.

## Depois

- Cada push no `main` publica sozinho (o Coolify liga o deploy automático pelo GitHub App).
- Logs: no Coolify, abra o recurso → **Logs**.
- Se o bot cair, `https://SEU-DOMINIO/status` mostra o motivo da última desconexão.
