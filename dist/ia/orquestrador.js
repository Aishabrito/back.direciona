"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ESTADO_INICIAL = void 0;
exports.processarTurno = processarTurno;
// src/ia/orquestrador.ts
const auditoria_js_1 = require("./auditoria.js");
const extrator_de_informacoes_js_1 = require("./extrator_de_informacoes.js");
const mensagens_js_1 = require("./mensagens.js");
const motor_de_regras_js_1 = require("./motor_de_regras.js");
const perguntas_js_1 = require("./perguntas.js");
const faq_js_1 = require("./faq.js");
const tipos_js_1 = require("./tipos.js");
const validador_de_saida_js_1 = require("./validador_de_saida.js");
exports.ESTADO_INICIAL = {
    relatos: [],
    rodadasPerguntas: 0,
    texto_original_acumulado: '',
};
function consolidar(estado) {
    const base = estado.relatos.reduce((acc, item) => (0, validador_de_saida_js_1.mesclarRelatos)(acc, item), { ...tipos_js_1.RELATO_VAZIO });
    return {
        ...base,
        texto_original_acumulado: estado.texto_original_acumulado || '',
    };
}
function precisaPerguntar(relato) {
    // Sinais de alarme imediatos (NÃO atrasar):
    if (relato.sinais_alerta.length > 0)
        return false;
    if (relato.sinais_obstetricos && relato.sinais_obstetricos.length > 0)
        return false;
    if (relato.sinais_trauma && relato.sinais_trauma.length > 0)
        return false;
    if (relato.risco_mental === 'iminente')
        return false;
    // Queixa sem conteúdo suficiente
    if (relato.informacao_insuficiente)
        return true;
    // Refinamento de sintomas não-emergenciais: se ainda não sabemos duração ou contexto
    if (relato.sintomas.length > 0) {
        const semDuracao = relato.duracao === 'nao_informado';
        const temQueixaIntermediaria = relato.febre === true ||
            relato.vomitos === true ||
            relato.sintomas.some((s) => /dor|febre|tosse|resfriado|enjoo|queimadura|queda|ferida/i.test(s));
        if (semDuracao || temQueixaIntermediaria) {
            return true;
        }
    }
    return false;
}
async function processarTurno(textoUsuario, estado) {
    // 1. Dúvidas institucionais e operacionais do SUS
    const faqEncontrada = (0, faq_js_1.checarFaq)(textoUsuario);
    if (faqEncontrada) {
        return {
            estado,
            resultado: {
                tipo: 'orientacao',
                texto: faqEncontrada.resposta,
                decisao: {
                    categoria_interna: 'fora_do_escopo',
                    destino: 'FALLBACK',
                    resposta_id: faqEncontrada.id,
                    regra_acionada: faqEncontrada.id,
                    versao_regras: tipos_js_1.VERSAO_REGRAS,
                },
            },
        };
    }
    // 2. Pedidos expressos de medicamento ou posologia
    if ((0, mensagens_js_1.ehPedidoMedicamento)(textoUsuario)) {
        const msg = (0, mensagens_js_1.mensagemPorId)('recusa_medicamento');
        return {
            estado,
            resultado: {
                tipo: 'orientacao',
                texto: msg.texto,
                decisao: {
                    categoria_interna: 'fora_do_escopo',
                    destino: 'FALLBACK',
                    resposta_id: 'recusa_medicamento',
                    regra_acionada: 'bloqueio_medicamento',
                    versao_regras: tipos_js_1.VERSAO_REGRAS,
                },
            },
        };
    }
    // 3. Pedidos expressos de diagnóstico médico
    if ((0, mensagens_js_1.ehPedidoDiagnostico)(textoUsuario)) {
        const msg = (0, mensagens_js_1.mensagemPorId)('recusa_diagnostico');
        return {
            estado,
            resultado: {
                tipo: 'orientacao',
                texto: msg.texto,
                decisao: {
                    categoria_interna: 'fora_do_escopo',
                    destino: 'FALLBACK',
                    resposta_id: 'recusa_diagnostico',
                    regra_acionada: 'bloqueio_diagnostico',
                    versao_regras: tipos_js_1.VERSAO_REGRAS,
                },
            },
        };
    }
    // 4. Extração clínica e estruturação do relato
    const textoAcumulado = estado.texto_original_acumulado
        ? `${estado.texto_original_acumulado} ${textoUsuario}`
        : textoUsuario;
    const extraido = await (0, extrator_de_informacoes_js_1.interpretarRelato)(textoUsuario);
    // 5. Verificação de assunto totalmente fora de saúde/sintomas (confiando na IA/fallback)
    // Agora usamos informacao_insuficiente como indicador primário
    const semSintomasOuSinais = extraido.informacao_insuficiente === true &&
        extraido.sintomas.length === 0 &&
        extraido.sinais_alerta.length === 0 &&
        extraido.risco_mental === 'nao_mencionado';
    if (semSintomasOuSinais && estado.relatos.length === 0) {
        const msgForaEscopo = (0, mensagens_js_1.mensagemPorId)('fora_escopo_001');
        return {
            estado,
            resultado: {
                tipo: 'orientacao',
                texto: msgForaEscopo.texto,
                decisao: {
                    categoria_interna: 'fora_do_escopo',
                    destino: 'FALLBACK',
                    resposta_id: 'fora_escopo_001',
                    regra_acionada: 'fora_do_escopo_inicial',
                    versao_regras: tipos_js_1.VERSAO_REGRAS,
                },
            },
        };
    }
    const relatos = [...estado.relatos, extraido];
    const atual = consolidar({ ...estado, relatos, texto_original_acumulado: textoAcumulado });
    // 6. Linha vermelha: emergência imediata
    const emergenciaImediata = atual.risco_mental === 'iminente' ||
        (atual.idade_grupo === 'bebe' && atual.febre === true) ||
        (atual.trauma === true && (atual.confusao === true || atual.desmaio === true)) ||
        (atual.dor_no_peito === true &&
            (atual.falta_de_ar === true || atual.desmaio === true || atual.confusao === true)) ||
        atual.desmaio === true ||
        (atual.sinais_obstetricos && atual.sinais_obstetricos.length > 0) ||
        (atual.sinais_trauma && atual.sinais_trauma.length > 0);
    // 7. Rodada única de refinamento clínico se não for emergência
    if (!emergenciaImediata && estado.rodadasPerguntas < 1 && precisaPerguntar(atual)) {
        const tema = (0, perguntas_js_1.escolherTemaPergunta)({
            sintomas: atual.sintomas,
            idade_grupo: atual.idade_grupo,
            gestante: atual.gestante,
            risco_mental: atual.risco_mental,
            falta_de_ar: atual.falta_de_ar,
            febre: atual.febre,
        });
        const perguntas = perguntas_js_1.PERGUNTAS[tema] || perguntas_js_1.PERGUNTAS.vago;
        return {
            estado: {
                relatos,
                rodadasPerguntas: estado.rodadasPerguntas + 1,
                temaPergunta: tema,
                texto_original_acumulado: textoAcumulado,
            },
            resultado: {
                tipo: 'perguntas',
                tema,
                perguntas,
                texto: perguntas.join('\n'),
            },
        };
    }
    // 8. Decisão pelo motor de regras clínicas
    const decisao = (0, motor_de_regras_js_1.aplicarMotor)(atual, textoAcumulado);
    if (decisao.categoria_interna === 'informacao_insuficiente' && estado.rodadasPerguntas < 1) {
        const perguntas = perguntas_js_1.PERGUNTAS.vago;
        return {
            estado: {
                relatos,
                rodadasPerguntas: estado.rodadasPerguntas + 1,
                temaPergunta: 'vago',
                texto_original_acumulado: textoAcumulado,
            },
            resultado: {
                tipo: 'perguntas',
                tema: 'vago',
                perguntas,
                texto: perguntas.join('\n'),
            },
        };
    }
    const mensagem = (0, mensagens_js_1.sanitizarResposta)((0, mensagens_js_1.mensagemPorId)(decisao.resposta_id).texto, decisao.resposta_id);
    (0, auditoria_js_1.registrarDecisao)(decisao);
    return {
        estado: {
            relatos,
            rodadasPerguntas: 0,
            temaPergunta: undefined,
            texto_original_acumulado: textoAcumulado,
        },
        resultado: {
            tipo: 'orientacao',
            texto: mensagem,
            decisao,
        },
    };
}
