import { describe, it, expect, beforeAll } from 'vitest';
import type { EstadoConversa } from '../../ia/tipos.js';
import { atenderTexto, atenderLocalizacao, type Canal } from '../atendimento.js';

// Sem chave da IA, o orquestrador usa as regras fixas; a guarda de emergência é a mesma.
beforeAll(() => { delete process.env.GROQ_API_KEY; });

// Canal de teste: guarda o estado em memória e acumula as mensagens enviadas.
function canalTeste() {
  let estado: EstadoConversa | null = null;
  const enviadas: string[] = [];
  const canal: Canal = {
    sessaoLog: 'teste',
    carregar: async () => estado,
    salvar: async (e) => { estado = e; },
    apagar: async () => { estado = null; },
    enviar: async (m) => { enviadas.push(m.texto); },
    local: 'botão 📍',
    localDestaque: 'botão *📍*',
    boasVindasNaPrimeira: false,
  };
  return { canal, enviadas, estado: () => estado };
}

// Ilha do Governador (há UPAs na base local do CNES, sem precisar de internet).
const ILHA = { lat: -22.8048, lng: -43.2199 };

describe('atendimento (o mesmo para WhatsApp e app)', () => {
  it('emergência oferece o hospital mais próximo, com a instrução do canal', async () => {
    const t = canalTeste();
    await atenderTexto(t.canal, 'meu pai está com a boca torta e fala enrolada');
    const ultima = t.enviadas.at(-1)!;
    expect(ultima).toContain('192');
    expect(ultima).toContain('o hospital mais próximo');
    expect(ultima).toContain('(botão 📍)');
    expect(t.estado()?.aguardandoLocalizacao?.tipo).toBe('HOSPITAL');
  });

  it('localização depois da oferta busca e lista as unidades', async () => {
    const t = canalTeste();
    await atenderTexto(t.canal, 'meu pai está com a boca torta e fala enrolada');
    await atenderLocalizacao(t.canal, ILHA.lat, ILHA.lng);
    expect(t.enviadas.at(-2)).toContain('Buscando as unidades');
    expect(t.enviadas.at(-1)).toMatch(/km/);
    expect(t.estado()?.aguardandoLocalizacao).toBeUndefined();
  });

  it('"não" depois da oferta encerra a oferta', async () => {
    const t = canalTeste();
    await atenderTexto(t.canal, 'meu pai está com a boca torta e fala enrolada');
    await atenderTexto(t.canal, 'não');
    expect(t.enviadas.at(-1)).toContain('Tudo bem');
    expect(t.estado()?.aguardandoLocalizacao).toBeUndefined();
  });

  it('pedido direto ("onde tem uma UPA?") pede a localização', async () => {
    const t = canalTeste();
    await atenderTexto(t.canal, 'onde tem uma upa?');
    expect(t.enviadas.at(-1)).toContain('a UPA mais próxima');
    expect(t.estado()?.aguardandoLocalizacao?.tipo).toBe('UPA');
  });

  it('localização sem oferta pergunta o que buscar; depois "upa" busca', async () => {
    const t = canalTeste();
    await atenderLocalizacao(t.canal, ILHA.lat, ILHA.lng);
    expect(t.enviadas.at(-1)).toContain('UPA*, *UBS* ou *hospital');
    await atenderTexto(t.canal, 'upa');
    expect(t.enviadas.at(-1)).toMatch(/UPA/);
    expect(t.enviadas.at(-1)).toMatch(/km/);
  });

  it('"início" recomeça e "apagar" apaga os dados', async () => {
    const t = canalTeste();
    await atenderTexto(t.canal, 'meu pai está com a boca torta e fala enrolada');
    await atenderTexto(t.canal, 'início');
    expect(t.estado()?.aguardandoLocalizacao).toBeUndefined();
    await atenderTexto(t.canal, 'apagar');
    expect(t.enviadas.at(-1)).toContain('Seus dados foram apagados');
    expect(t.estado()).toBeNull();
  });
});
