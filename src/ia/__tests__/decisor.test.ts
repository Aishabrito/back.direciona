import { describe, it, expect, vi, beforeEach } from 'vitest';

// LLM simulado: cada teste enfileira o que o "modelo" responde.
const respostasLLM: unknown[] = [];
vi.mock('../../servicos/ia.js', () => ({
  getGroq: () => null,
  gerarJSON: vi.fn(async () => {
    if (respostasLLM.length === 0) return null;
    const dados = respostasLLM.shift();
    return dados === null ? null : { dados, uso: { tokens_in: 100, tokens_out: 20 } };
  }),
}));

import { gerarJSON } from '../../servicos/ia.js';
import { processarTurno, ESTADO_INICIAL, TEXTO_ESCALONAMENTO } from '../orquestrador.js';
import { detectarCriticoRegex } from '../guarda_critica.js';
import { contemDiagnostico, contemPrescricao, TEXTO_SEGURO_RAG } from '../validacao_final.js';
import { parsearDecisao } from '../decisor.js';
import { ehReformulacao } from '../memoria.js';
import { mensagemPorId } from '../mensagens.js';
import type { EstadoConversa } from '../tipos.js';

function novoEstado(): EstadoConversa {
  return JSON.parse(JSON.stringify(ESTADO_INICIAL));
}

function llm(parcial: Record<string, unknown>) {
  return {
    acao: 'conversa', texto: '', destino: 'NENHUM', pergunta_proxima: '', pergunta_rag: '',
    motivo_interno: 'teste',
    fatos_novos: { idade: 0, gestante: 'nao_informado', doencas_cronicas: [], mora_em: '', pessoa_atendida: '' },
    resumo: '',
    ...parcial,
  };
}

beforeEach(() => {
  respostasLLM.length = 0;
  vi.mocked(gerarJSON).mockClear();
});

// ═══════════════════════════════════════════════════════════
describe('guarda crítica enxuta', () => {
  it.each([
    ['estou com dor no peito', 'dor_toracica'],
    ['ele não está respirando', 'pcr'],
    ['quero me matar', 'suicidio'],
    ['minha mãe está com a boca torta', 'avc'],
    ['meu filho está engasgado', 'engasgo'],
    ['não tenho dor no peito, mas estou com falta de ar', 'falta_de_ar'],
    ['Bati minha cabeça e está sangrando', 'trauma_craniano'],
    ['meu pai caiu e está com fratura exposta na perna', 'trauma_grave'],
    ['Teve um acidente de moto, motoqueiro está desmaiado oq faco ?', 'trauma_grave'],
    ['meu avô está desmaiado no chão', 'inconsciente'],
  ])('"%s" → %s', (texto, categoria) => {
    const r = detectarCriticoRegex(texto);
    expect(r.critico).toBe(true);
    if (r.critico) expect(r.categoria).toBe(categoria);
  });

  it.each([
    'meu xixi está queimando',
    'meu filho não respira bem pelo nariz, está com coriza',
    'meu bebê de 40 dias está com tosse',
    'estou tremendo muito de frio e com febre',
    'a luz apagou aqui em casa',
    'não tenho dor no peito',
    'o que fazer em caso de falta de ar?',
    'quais os sinais de AVC?',
    'ele não está desmaiado, só tonto',
    'o que fazer se alguém estiver inconsciente?',
    'desmaiei ontem mas estou bem',
  ])('NÃO dispara: "%s"', (texto) => {
    expect(detectarCriticoRegex(texto).critico).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
describe('validação final — detectores', () => {
  it('diagnóstico associado ao usuário', () => {
    expect(contemDiagnostico('Você pode estar com dengue.')).toBe(true);
    expect(contemDiagnostico('Seus sintomas indicam uma virose.')).toBe(true);
    expect(contemDiagnostico('Você tem suspeita de dengue.')).toBe(true);
    expect(contemDiagnostico('A dengue é transmitida pelo mosquito Aedes aegypti.')).toBe(false);
    expect(contemDiagnostico('Os sintomas clássicos são febre e dor no corpo. Se houver suspeita de dengue, procure uma UBS.')).toBe(false);
  });
  it('prescrição', () => {
    expect(contemPrescricao('Tome dipirona de 6 em 6 horas.')).toBe(true);
    expect(contemPrescricao('Use 500 mg de paracetamol.')).toBe(true);
    expect(contemPrescricao('Não tome antibiótico sem receita.')).toBe(false);
  });
});

describe('protocolo certo para outra pessoa', () => {
  it('acidente com motoqueiro → protocolo de trauma (não mover, não tirar capacete)', async () => {
    const { resultado } = await processarTurno('Teve um acidente de moto, motoqueiro está desmaiado oq faco ?', novoEstado());
    expect(resultado.texto).toMatch(/NÃO mova/);
    expect(resultado.texto).toMatch(/capacete/);
  });
});

describe('acidentes de trânsito', () => {
  it.each([
    'sofri um acidente de moto agora, estou sangrando',
    'bati o carro, tem uma pessoa presa nas ferragens',
    'acidente de carro ontem, hoje estou vomitando',
  ])('grave ou agora → guarda SAMU: "%s"', (t) => {
    expect(detectarCriticoRegex(t)).toMatchObject({ critico: true, categoria: 'trauma_grave' });
  });

  it.each(['bati o carro ontem e estou com dor no pescoço', 'caí de moto ontem, só ralei o joelho'])(
    'passado sem sinal grave → não é SAMU direto: "%s"', (t) => expect(detectarCriticoRegex(t).critico).toBe(false),
  );

  it('acidente de ontem: LLM diz UBS → validação sobe para UPA', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Procure a UBS.' }));
    const { resultado } = await processarTurno('bati o carro ontem e estou com dor no pescoço', novoEstado());
    expect(resultado.tipo).toBe('orientacao');
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.destino).toBe('UPA_24H');
    expect(resultado.texto).toMatch(/lesões internas/);
  });

  it('acidente antigo e leve: UBS é aceito', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Pode acompanhar na UBS.' }));
    const { resultado } = await processarTurno('caí de moto semana passada, o joelho ralado está cicatrizando', novoEstado());
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.destino).toBe('UBS_CLINICA_DA_FAMILIA');
  });
});

describe('dor de cabeça', () => {
  it.each([
    'a pior dor de cabeça da minha vida, começou do nada',
    'estou com dor de cabeça forte, febre e o pescoço duro',
    'dor de cabeça muito forte que começou de repente',
  ])('sinal de alarme → SAMU: "%s"', (t) => {
    expect(detectarCriticoRegex(t)).toMatchObject({ critico: true, categoria: 'cefaleia_alarme' });
  });

  it('dor de cabeça + nuca não dispara SAMU sozinha', () => {
    expect(detectarCriticoRegex('estou com dor de cabeca e dor na nuca').critico).toBe(false);
  });

  it('com febre: LLM diz UBS → validação sobe para UPA', async () => {
    let estado = novoEstado();
    respostasLLM.push(llm({ acao: 'perguntar', texto: 'Tem febre?', pergunta_proxima: 'Tem febre?' }));
    estado = (await processarTurno('estou com dor de cabeca e dor na nuca', estado)).estado;
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Procure a UBS.' }));
    const { resultado } = await processarTurno('sim, febre desde ontem', estado);
    expect(resultado.tipo).toBe('orientacao');
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.destino).toBe('UPA_24H');
  });

  it('sem febre, há dias: UBS é aceito', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Pode procurar a UBS.' }));
    const { resultado } = await processarTurno('dor de cabeça e nuca tensa há 3 dias, sem febre', novoEstado());
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.destino).toBe('UBS_CLINICA_DA_FAMILIA');
  });
});

describe('queimaduras', () => {
  it.each([
    'caiu soda cáustica no braço dele',
    'meu filho levou um choque do fio do poste',
    'queimadura química no rosto',
    'ele inalou muita fumaça no incêndio',
    'a roupa pegou fogo no corpo',
  ])('grave → SAMU: "%s"', (t) => {
    expect(detectarCriticoRegex(t)).toMatchObject({ critico: true, categoria: 'queimadura_grave' });
  });

  it.each([
    'meu xixi está queimando',
    'sinto queimação no estômago',
    'queimei a mão no forno e fez bolha',
    'não inalou fumaça, só queimou o dedo',
  ])('não dispara SAMU: "%s"', (t) => {
    expect(detectarCriticoRegex(t).critico).toBe(false);
  });

  it('bolha: LLM diz UBS → validação sobe para UPA com orientação segura', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Procure a UBS.' }));
    const { resultado } = await processarTurno('queimei a mão no forno e fez bolha', novoEstado());
    expect(resultado.tipo).toBe('orientacao');
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.destino).toBe('UPA_24H');
    expect(resultado.texto).toMatch(/sem gelo/);
  });

  it('choque na tomada: nunca abaixo de UPA', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Procure a UBS.' }));
    const { resultado } = await processarTurno('meu filho levou choque na tomada, parece bem', novoEstado());
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.destino).toBe('UPA_24H');
  });

  it('pequena, só vermelha, no braço de adulto: UBS é aceito', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Pode procurar a UBS.' }));
    const { resultado } = await processarTurno('queimei o braço com água quente, ficou só vermelho, do tamanho de uma moeda', novoEstado());
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.destino).toBe('UBS_CLINICA_DA_FAMILIA');
  });
});

describe('parser do decisor (schema fechado)', () => {
  it('ignora campos fora do schema e ação inválida', () => {
    expect(parsearDecisao({ acao: 'diagnosticar', texto: 'x' })).toBeNull();
    const d = parsearDecisao(llm({ acao: 'orientar', destino: 'UBS', diagnostico: 'gripe' }));
    expect(d).not.toBeNull();
    expect(d).not.toHaveProperty('diagnostico');
  });
  it('destino desconhecido vira NENHUM', () => {
    expect(parsearDecisao(llm({ destino: 'HOSPITAL_X' }))!.destino).toBe('NENHUM');
  });
});

describe('reformulação', () => {
  it('mensagem parecida com a anterior conta; respostas curtas não', () => {
    const hist = [{ role: 'user' as const, content: 'estou com muita dor de cabeça forte', ts: 0 }];
    expect(ehReformulacao('to com muita dor de cabeça bem forte', hist)).toBe(true);
    expect(ehReformulacao('sim', [{ role: 'user', content: 'sim', ts: 0 }])).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
describe('conversas (LLM simulado)', () => {
  it('dor no peito → guarda escala para SAMU SEM chamar o LLM', async () => {
    const { resultado, estado } = await processarTurno('estou com dor no peito', novoEstado());
    expect(gerarJSON).not.toHaveBeenCalled();
    expect(resultado.tipo).toBe('orientacao');
    expect(resultado.texto).toContain('192');
    expect(resultado.tipo).toBe('orientacao');
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.nivel).toBe('SAMU_AGORA');
    expect(estado.fase).toBe('orientado');
  });

  it('dor no peito com o LLM FORA DO AR → continua SAMU', async () => {
    const { resultado } = await processarTurno('to sentindo um aperto no peito', novoEstado());
    expect(resultado.tipo).toBe('orientacao');
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.nivel).toBe('SAMU_AGORA');
  });

  it('piso crítico: LLM diz UBS para bebê de 1 mês com febre → vira emergência', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Procure a UBS.' }));
    const { resultado } = await processarTurno('meu filho de 1 mes está com febre', novoEstado());
    expect(resultado.tipo).toBe('orientacao');
    if (resultado.tipo === 'orientacao') {
      expect(resultado.decisao.nivel).toBe('SAMU_AGORA');
      expect(resultado.decisao.regra_acionada).toBe('llm:emergencia');
    }
  });

  it('emergência do LLM usa texto aprovado, não o texto gerado', async () => {
    respostasLLM.push(llm({ acao: 'emergencia', destino: 'SAMU_192', texto: 'Fica tranquila, deve ser nada, mas liga.' }));
    const { resultado } = await processarTurno('minha vó caiu e tá falando coisa sem sentido', novoEstado());
    expect(resultado.texto).toBe(mensagemPorId('emergencia_001').texto);
  });

  it('texto com diagnóstico é trocado SEM rebaixar o destino', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UPA', texto: 'Você pode estar com dengue. Vá à UPA.' }));
    const { resultado } = await processarTurno('estou com febre há 4 dias e dor no corpo', novoEstado());
    expect(resultado.texto).not.toMatch(/dengue/i);
    expect(resultado.tipo).toBe('orientacao');
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.destino).toBe('UPA_24H');
  });

  it('orientação do LLM ganha a linha fixa de "onde ir"', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Parece algo leve, mas vale avaliar.' }));
    const { resultado } = await processarTurno('estou com coriza há 2 dias, sem febre', novoEstado());
    expect(resultado.texto).toContain('Onde ir:* UBS');
    expect(resultado.tipo).toBe('orientacao');
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.resposta_id).toBe('ubs_001');
  });

  it('"orientar" com destino SAMU vira emergência', async () => {
    respostasLLM.push(llm({ acao: 'orientar', destino: 'SAMU_192', texto: 'Ligue 192.' }));
    const { resultado } = await processarTurno('meu avô está muito mole e sem reagir', novoEstado());
    expect(resultado.tipo).toBe('orientacao');
    if (resultado.tipo === 'orientacao') expect(resultado.decisao.categoria_interna).toBe('emergencia');
  });

  it('perguntar sem pergunta → usa pergunta fixa', async () => {
    respostasLLM.push(llm({ acao: 'perguntar', texto: 'Entendi.' }));
    const { resultado, estado } = await processarTurno('estou com febre', novoEstado());
    expect(resultado.tipo).toBe('perguntas');
    expect(resultado.texto).toContain('?');
    expect(estado.fase).toBe('coletando');
    expect(estado.perguntasJaFeitas).toHaveLength(1);
  });

  it('limite de perguntas → orienta pelo motor', async () => {
    let estado = novoEstado();
    for (const p of ['Há quantos dias?', 'Tem manchas?', 'Está bebendo líquidos?']) {
      respostasLLM.push(llm({ acao: 'perguntar', texto: p, pergunta_proxima: p }));
      estado = (await processarTurno(`resposta ${p}`, estado)).estado;
    }
    respostasLLM.push(llm({ acao: 'perguntar', texto: 'E dor?', pergunta_proxima: 'E dor?' }));
    const { resultado } = await processarTurno('não sei', estado);
    expect(resultado.tipo).toBe('orientacao');
  });

  it('ação inválida do LLM → fallback determinístico', async () => {
    respostasLLM.push({ acao: 'diagnosticar', texto: 'Você tem gripe' });
    const { resultado } = await processarTurno('estou com tosse', novoEstado());
    expect(resultado.texto).not.toMatch(/gripe/i);
    expect(resultado.tipo).toBe('perguntas');
  });

  it('LLM fora do ar: saudação e triagem continuam funcionando', async () => {
    const r1 = await processarTurno('oi', novoEstado());
    expect(r1.resultado.acao).toBe('conversa');
    const r2 = await processarTurno('estou com tosse', r1.estado);
    expect(r2.resultado.tipo).toBe('perguntas');
  });

  it('RAG: LLM decide responder_rag → busca na base → LLM redige', async () => {
    respostasLLM.push(llm({ acao: 'responder_rag', pergunta_rag: 'O que é dengue e como se transmite?' }));
    respostasLLM.push({ texto: 'A dengue é transmitida pela picada do mosquito Aedes aegypti.' });
    const { resultado } = await processarTurno('o que é dengue?', novoEstado());
    expect(resultado.texto).toContain('Aedes');
    expect(gerarJSON).toHaveBeenCalledTimes(2);
  });

  it('RAG com LLM fora do ar → devolve o tópico curado da base', async () => {
    const { resultado } = await processarTurno('o que é dengue?', novoEstado());
    expect(resultado.texto).toMatch(/Aedes/);
  });

  it('RAG: redação com diagnóstico é bloqueada', async () => {
    respostasLLM.push(llm({ acao: 'responder_rag', pergunta_rag: 'O que é gripe?' }));
    respostasLLM.push({ texto: 'Pelos seus sintomas, você provavelmente tem gripe.' });
    const { resultado } = await processarTurno('o que é gripe?', novoEstado());
    expect(resultado.texto).toBe(TEXTO_SEGURO_RAG);
  });

  it('3 tentativas iguais → escalonamento para canal humano', async () => {
    let estado = novoEstado();
    for (let i = 0; i < 2; i++) {
      respostasLLM.push(llm({ acao: 'perguntar', texto: `Pergunta ${i}?`, pergunta_proxima: `Pergunta ${i}?` }));
      estado = (await processarTurno('preciso de ajuda com minha dor nas costas', estado)).estado;
    }
    const { resultado, estado: final } = await processarTurno('preciso de ajuda com a minha dor nas costas', estado);
    expect(resultado.texto).toBe(TEXTO_ESCALONAMENTO);
    expect(final.falhasSeguidas).toBe(0);
  });

  it('memória: fatos aprendidos entram no prompt do próximo turno', async () => {
    respostasLLM.push(llm({
      acao: 'perguntar', texto: 'O que ela está sentindo?', pergunta_proxima: 'O que ela está sentindo?',
      fatos_novos: { idade: 78, gestante: 'nao_informado', doencas_cronicas: ['diabetes'], mora_em: '', pessoa_atendida: 'mãe' },
    }));
    const r1 = await processarTurno('minha mãe tem 78 anos e é diabética', novoEstado());
    expect(r1.estado.memoria?.fatos).toMatchObject({ idade: 78, idade_grupo: 'idoso', doencas_cronicas: ['diabetes'] });

    respostasLLM.push(llm({ acao: 'orientar', destino: 'UBS', texto: 'Pode procurar a UBS.' }));
    await processarTurno('ela está com tosse leve', r1.estado);
    const prompt = vi.mocked(gerarJSON).mock.calls[1][0];
    expect(prompt).toContain('"idade":78');
  });

  it('estado salvo em versão antiga (sem memória) não quebra', async () => {
    const antigo = { relatos: [], rodadasPerguntas: 0, texto_original_acumulado: '', fase: 'inicio', perguntasJaFeitas: [] } as any;
    const { estado } = await processarTurno('oi', antigo);
    expect(estado.memoria).toBeDefined();
  });
});
