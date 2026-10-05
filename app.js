/* =====================================================================
     FilaFácil — refatorado
     1) FilaService é SINGLETON: painel, telão e kiosk compartilham a MESMA fila
     2) Nº de senha gerado por sequência persistida sob Web Lock (sem corrida)
     3) Persistência isolada no repositório; render() não grava mais
     ===================================================================== */

  // ---------- helpers ----------

  const $ = (id) => document.getElementById(id);

  // O mesmo arquivo pode ser usado nas visões painel, telão e kiosk.
  // Esses helpers evitam que uma visão que não possui determinado elemento
  // derrube o JavaScript inteiro durante a inicialização.
  const on = (id, event, handler, options) => {
    const el = $(id);
    if (el) el.addEventListener(event, handler, options);
    return el;
  };

  const setText = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };

  const params = new URLSearchParams(location.search);
  const viewMode = params.get("view") || "painel";

  if (viewMode === "telao") {
    document.body.classList.add("mode-telao");
  }

  if (viewMode === "kiosk") {
    document.body.classList.add("mode-kiosk");
  }

  if (viewMode === "cliente") {
    document.body.classList.add("mode-cliente");
  }

  const MAX_SENHA = 9999;

  const PRIORIDADES = {
    preferencial: 0,
    atacado: 1,
    comum: 2,
  };

  const LABELS = {
    preferencial: "Preferencial",
    atacado: "Atacado",
    comum: "Comum",
  };

  const STATUS = {
    fila: {
      label: "Na fila",
      cls: "",
    },
    atendimento: {
      label: "Em atendimento",
      cls: "atendimento",
    },
    resolvido: {
      label: "Resolvido",
      cls: "resolvido",
    },
    cancelado: {
      label: "Cancelado",
      cls: "cancelado",
    },
  };

  const STATUS_OK = Object.keys(STATUS);

  const sample = [
    {
      id: 3,
      priority: "preferencial",
      status: "fila",
      time: "14:20",
      order: 1,
      senha: 1,
      guiche: null,
    },
    {
      id: 7,
      priority: "comum",
      status: "fila",
      time: "14:25",
      order: 2,
      senha: 2,
      guiche: null,
    },
    {
      id: 10,
      priority: "comum",
      status: "fila",
      time: "14:28",
      order: 3,
      senha: 3,
      guiche: null,
    },
    {
      id: 5,
      priority: "atacado",
      status: "fila",
      time: "14:31",
      order: 4,
      senha: 4,
      guiche: null,
    },
    {
      id: 8,
      priority: "atacado",
      status: "fila",
      time: "14:35",
      order: 5,
      senha: 5,
      guiche: null,
    },
  ];

  function hhmm(d) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}`;
  }

  function formatarSenha(t) {
    return t && Number.isInteger(Number(t.senha))
      ? String(t.senha).padStart(4, "0")
      : "----";
  }

  function formatarGuiche(n) {
    return n ? `Guichê ${String(n).padStart(2, "0")}` : "";
  }

  function safe(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c])
    );
  }

  let toastTimer;

  function toast(msg) {
    const el = $("toast");

    if (!el) return;

    el.textContent = msg;
    el.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      el.classList.remove("show");
    }, 2800);
  }

  // ---------- 1) REPOSITÓRIO ----------

  const CHAVE_DADOS = "filafacil_tickets_v5";
  const CHAVE_SEQ = "filafacil_seq_v6";
  const CHAVE_GUICHE = "filafacil_guiche";
  const CHAVE_PREFS = "filafacil_prefs_v6";
  const CHAVE_LOCK = "filafacil_mutex";

  const RepositorioSenhas = {
    carregar() {
      const padrao = () => sample.map((t) => ({ ...t }));

      let tickets;

      try {
        let bruto = localStorage.getItem(CHAVE_DADOS);

        if (!bruto) {
          for (const k of [
            "filafacil_tickets_v4",
            "filafacil_tickets_v3",
            "filafacil_tickets_v2",
            "filafacil_tickets_v1",
          ]) {
            bruto = localStorage.getItem(k);

            if (bruto) break;
          }
        }

        const lista = bruto ? JSON.parse(bruto) : padrao();

        if (!Array.isArray(lista)) {
          throw new Error("formato");
        }

        tickets = lista
          .filter((t) => t && typeof t === "object")
          .map((t) => ({ ...t }));
      } catch {
        tickets = padrao();
      }

      let seq = Number(localStorage.getItem(CHAVE_SEQ)) || 0;

      let ordem = 0;
      let idMax = 0;

      tickets.forEach((t) => {
        if (Number.isInteger(t.id)) {
          idMax = Math.max(idMax, t.id);
        }

        ordem = Math.max(ordem, Number(t.order) || 0);
      });

      // Normalização — compatível com dados antigos
      tickets.forEach((t) => {
        const n = Number(t.senha);

        t.senha =
          Number.isInteger(n) && n >= 1 && n <= MAX_SENHA ? n : null;

        if (t.status === "aberto") {
          t.status = "fila";
        }

        if (!STATUS_OK.includes(t.status)) {
          t.status = "fila";
        }

        if (t.priority === "alta") {
          t.priority = "preferencial";
        } else if (t.priority === "baixa") {
          t.priority = "atacado";
        } else if (t.priority === "media") {
          t.priority = "comum";
        }

        if (!Object.prototype.hasOwnProperty.call(PRIORIDADES, t.priority)) {
          t.priority = "comum";
        }

        t.guiche =
          t.guiche == null ? null : Number(t.guiche) || null;

        t.calledAt = Number(t.calledAt) || 0;
        t.order = Number(t.order) || 0;
        t.time = typeof t.time === "string" ? t.time : "";

        delete t.title;
        delete t.description;
      });

      // Completa buracos de dados antigos/corrompidos
      tickets.forEach((t) => {
        if (!Number.isInteger(t.id)) {
          t.id = ++idMax;
        }

        if (!t.order) {
          t.order = ++ordem;
        }
      });

      seq = Math.max(
        seq,
        tickets.reduce((m, t) => Math.max(m, t.senha || 0), 0)
      );

      tickets.forEach((t) => {
        if (!t.senha) {
          seq = seq >= MAX_SENHA ? 1 : seq + 1;
          t.senha = seq;
        }
      });

      return {
        tickets,
        seq,
        ordem,
        idMax,
      };
    },

    salvar(tickets, seq) {
      try {
        localStorage.setItem(CHAVE_DADOS, JSON.stringify(tickets));
        localStorage.setItem(CHAVE_SEQ, String(seq));
      } catch {
        if (viewMode === "painel") {
          toast("Não foi possível salvar os dados.");
        }
      }
    },

    notificar() {
      try {
        canal?.postMessage(Date.now());
      } catch {}
    },
  };

  // ---------- sincronização entre abas ----------

  const canal =
    "BroadcastChannel" in window
      ? new BroadcastChannel("filafacil_sync")
      : null;

  canal?.addEventListener("message", () => {
    filaService.recarregar();
  });

  window.addEventListener("storage", (e) => {
    if (e.key === CHAVE_DADOS || e.key === CHAVE_SEQ) {
      filaService.recarregar();
    }
  });

  // ---------- 2) SERVIÇO ÚNICO DA FILA ----------

  class FilaService {
    constructor(repo) {
      this.repo = repo;
      this.listeners = new Set();

      this.#carregar();
    }

    #carregar() {
      const s = this.repo.carregar();

      this.tickets = s.tickets;
      this.seq = s.seq;
      this.ordemSeq = s.ordem;
      this.idSeq = s.idMax;
    }

    inscrever(fn) {
      this.listeners.add(fn);
    }

    #avisar() {
      this.listeners.forEach((fn) => fn());
    }

    // Toda mutação passa por aqui:
    // lock entre abas → grava → avisa as outras
    async #mutar(fn) {
      // IMPORTANTE: cada aba mantém sua própria cópia em memória.
      // Portanto, o estado precisa ser recarregado DENTRO do lock,
      // antes da mutação. Caso contrário, duas abas podem sobrescrever
      // alterações uma da outra usando dados antigos.
      const comLock = () => {
        this.#carregar();

        const r = fn();

        this.repo.salvar(this.tickets, this.seq);
        this.repo.notificar();

        return r;
      };

      const r = navigator.locks?.request
        ? await navigator.locks.request(CHAVE_LOCK, comLock)
        : comLock();

      this.#avisar();

      return r;
    }

    recarregar() {
      this.#carregar();
      this.#avisar();
    }

    // ---------- leituras ----------

    fila() {
      return this.tickets
        .filter((t) => t.status === "fila")
        .sort(
          (a, b) =>
            PRIORIDADES[a.priority] - PRIORIDADES[b.priority] ||
            a.order - b.order ||
            a.id - b.id
        );
    }

    porId(id) {
      return this.tickets.find((t) => t.id === id) || null;
    }

    emAtendimento(guiche = null) {
      return this.tickets.filter(
        (t) =>
          t.status === "atendimento" &&
          (guiche == null || Number(t.guiche) === Number(guiche))
      );
    }

    ultimaChamada() {
      return (
        this.tickets
          .filter((t) => t.status === "atendimento")
          .sort(
            (a, b) =>
              (b.calledAt || 0) - (a.calledAt || 0)
          )[0] || null
      );
    }

    contadores() {
      return {
        total: this.tickets.length,
        fila: this.fila().length,
        atendimento: this.emAtendimento().length,
        resolvido: this.tickets.filter(
          (t) => t.status === "resolvido"
        ).length,
      };
    }

    // ---------- operações ----------

    emitirSenha(priority) {
      return this.#mutar(() => {
        const prioridadeValida = Object.prototype.hasOwnProperty.call(
          PRIORIDADES,
          priority
        )
          ? priority
          : "comum";

        const usadas = new Set(
          this.tickets
            .map((t) => Number(t.senha))
            .filter(
              (n) =>
                Number.isInteger(n) &&
                n >= 1 &&
                n <= MAX_SENHA
            )
        );

        let senha = this.seq;

        // Procura a próxima senha livre, inclusive quando a sequência
        // precisa voltar para 0001.
        for (let i = 0; i < MAX_SENHA; i++) {
          senha = senha >= MAX_SENHA ? 1 : senha + 1;
          if (!usadas.has(senha)) break;
        }

        if (usadas.size >= MAX_SENHA && usadas.has(senha)) {
          throw new Error("Todas as senhas disponíveis estão em uso.");
        }

        this.seq = senha;

        const t = {
          id: ++this.idSeq,
          senha,
          priority: prioridadeValida,
          status: "fila",
          guiche: null,
          order: ++this.ordemSeq,
          time: hhmm(new Date()),
          calledAt: 0,
        };

        this.tickets.push(t);

        return t;
      });
    }

    chamarProxima(guicheId, idAlvo = null) {
      return this.#mutar(() => {
        if (this.emAtendimento(guicheId).length) {
          return null;
        }

        const alvo =
          idAlvo != null
            ? this.porId(Number(idAlvo))
            : this.fila()[0];

        if (!alvo || alvo.status !== "fila") {
          return null;
        }

        alvo.status = "atendimento";
        alvo.guiche = Number(guicheId);
        alvo.calledAt = Date.now();

        return alvo;
      });
    }

    resolver(id) {
      return this.#mutar(() => {
        const t = this.porId(id);

        if (t && t.status === "atendimento") {
          t.status = "resolvido";
          return t;
        }

        return null;
      });
    }

    cancelar(id) {
      return this.#mutar(() => {
        const t = this.porId(id);

        if (
          t &&
          (t.status === "fila" || t.status === "atendimento")
        ) {
          t.status = "cancelado";
          return t;
        }

        return null;
      });
    }

    limparResolvidos() {
      return this.#mutar(() => {
        this.tickets = this.tickets.filter(
          (t) => t.status !== "resolvido"
        );
      });
    }
  }

  // ---------- 3) GUICHÊ ----------

  class Guiche {
    constructor(id, service) {
      this.id = Number(id);
      this.service = service;
    }

    get atual() {
      return this.service.emAtendimento(this.id)[0] || null;
    }

    chamar(idAlvo = null) {
      return this.service.chamarProxima(this.id, idAlvo);
    }
  }

  // Instâncias únicas — nenhuma tela cria sua própria fila
  const filaService = new FilaService(RepositorioSenhas);

  const guicheAtual = new Guiche(
    Number(localStorage.getItem(CHAVE_GUICHE) || 1),
    filaService
  );

  // ---------- som / voz ----------

  const prefs = Object.assign(
    {
      som: true,
      voz: true,
      volume: 0.8,
    },
    (() => {
      try {
        return JSON.parse(
          localStorage.getItem(CHAVE_PREFS) || "{}"
        );
      } catch {
        return {};
      }
    })()
  );

  prefs.som = prefs.som !== false;
  prefs.voz = prefs.voz !== false;
  prefs.volume = Math.min(
    1,
    Math.max(
      0,
      Number.isFinite(Number(prefs.volume))
        ? Number(prefs.volume)
        : 0.8
    )
  );

  const salvarPrefs = () => {
    try {
      localStorage.setItem(
        CHAVE_PREFS,
        JSON.stringify(prefs)
      );
    } catch {}
  };

  let audioCtx;

  function beep(forcar = false) {
    if (!prefs.som && !forcar) return;

    try {
      audioCtx =
        audioCtx ||
        new (window.AudioContext ||
          window.webkitAudioContext)();

      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }

      const t0 = audioCtx.currentTime;

      [
        [880, 0],
        [1174.66, 0.18],
      ].forEach(([f, dt]) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();

        o.type = "sine";
        o.frequency.value = f;

        g.gain.setValueAtTime(
          Math.max(0.01, prefs.volume),
          t0 + dt
        );

        g.gain.exponentialRampToValueAtTime(
          0.001,
          t0 + dt + 0.22
        );

        o.connect(g);
        g.connect(audioCtx.destination);

        o.start(t0 + dt);
        o.stop(t0 + dt + 0.24);
      });
    } catch {}
  }

  const DIGITOS = [
    "zero",
    "um",
    "dois",
    "três",
    "quatro",
    "cinco",
    "seis",
    "sete",
    "oito",
    "nove",
  ];

  function falar(texto, forcar = false) {
    if (
      (!prefs.voz && !forcar) ||
      !("speechSynthesis" in window)
    ) {
      return;
    }

    speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(texto);

    u.lang = "pt-BR";
    u.rate = 0.95;
    u.volume = prefs.volume;

    speechSynthesis.speak(u);
  }

  function anunciar(t) {
    if (!t) return;

    beep();

    const num = String(t.senha)
      .padStart(4, "0")
      .split("")
      .map((d) => DIGITOS[+d])
      .join(" ");

    falar(
      `Senha ${num}. Guichê ${String(t.guiche).padStart(
        2,
        "0"
      )}.`
    );
  }

  // ---------- renderização ----------

  let ultimoAnuncio =
    filaService.ultimaChamada()?.calledAt || 0;

  function refresh() {
    processarChamadas();

    if (viewMode === "painel") {
      renderPainel();
    }

    if (viewMode === "telao") {
      renderTelao();
    }
  }

  function processarChamadas() {
    const u = filaService.ultimaChamada();

    if (
      !u ||
      !u.calledAt ||
      u.calledAt === ultimoAnuncio
    ) {
      return;
    }

    ultimoAnuncio = u.calledAt;

    anunciar(u);

    const box =
      viewMode === "telao"
        ? $("telaoCurrent")
        : document.querySelector(
            "#screenPanel .screen-current"
          );

    const num =
      viewMode === "telao"
        ? $("telaoNumber")
        : document.querySelector(
            "#screenPanel .screen-number"
          );

    if (box && num) {
      box.classList.remove("called");
      num.classList.remove("called-number");

      void box.offsetWidth;

      box.classList.add("called");
      num.classList.add("called-number");
    }
  }

  function renderPainel() {
    const c = filaService.contadores();

    $("total").textContent = c.total;
    $("waiting").textContent = c.fila;
    $("serving").textContent = c.atendimento;
    $("resolved").textContent = c.resolvido;

    const q = filaService.fila();

    $("queuePill").textContent =
      `${q.length} ${q.length === 1 ? "senha" : "senhas"}`;

    $("allPill").textContent =
      `${filaService.tickets.length} senhas`;

    const term = $("search").value
      .trim()
      .toLowerCase();

    const filtro = $("filter").value;

    const visiveis = q.filter(
      (t) =>
        formatarSenha(t).includes(term) &&
        (filtro === "todas" || t.priority === filtro)
    );

    $("rows").innerHTML = visiveis
      .map(
        (t, i) => `
          <tr>
            <td>
              <span class="pos ${safe(t.priority)}">
                ${i + 1}
              </span>
            </td>

            <td>
              <span class="id">
                ${formatarSenha(t)}
              </span>
            </td>

            <td>
              <span class="priority ${safe(t.priority)}">
                ${LABELS[t.priority]}
              </span>
            </td>

            <td>
              <span class="status">
                Na fila
              </span>
            </td>

            <td>
              <div class="row-actions">
                <button
                  class="row-action"
                  data-call="${t.id}"
                >
                  ➜ Chamar
                </button>

                <button
                  class="row-action danger"
                  data-cancel="${t.id}"
                >
                  ✕
                </button>
              </div>
            </td>
          </tr>
        `
      )
      .join("");

    $("empty").hidden = visiveis.length > 0;

    const agora = guicheAtual.atual;
    const proxima = q[0];
    const display = agora || proxima;

    $("nextBox").innerHTML = display
      ? `
        <div
          class="next-num"
          style="${agora ? "background:var(--blue)" : ""}"
        >
          ${formatarSenha(display)}
        </div>

        <div class="next-info">
          <strong>
            ${agora ? "Em atendimento" : "Próxima senha"}
          </strong>

          <p>
            ${
              agora
                ? formatarGuiche(guicheAtual.id)
                : "Aguardando chamada"
            }
          </p>
        </div>

        <span class="priority ${safe(display.priority)}">
          ${LABELS[display.priority]}
        </span>
      `
      : `
        <div
          class="next-num"
          style="background:#91a0b8"
        >
          —
        </div>

        <div class="next-info">
          <strong>Fila vazia</strong>
          <p>Gere uma senha ou aguarde o kiosk.</p>
        </div>
      `;

    const u = filaService.ultimaChamada();

    $("screenCurrent").textContent =
      u ? formatarSenha(u) : "----";

    $("screenCurrentGuiche").textContent =
      u ? formatarGuiche(u.guiche) : "";

    $("screenCurrentStatus").textContent = u
      ? "Dirija-se ao atendimento."
      : "Nenhuma senha está sendo atendida.";

    const upcoming = q.slice(0, 3);

    $("screenUpcoming").innerHTML = upcoming.length
      ? upcoming
          .map(
            (t) => `
              <div class="screen-upcoming-item">
                ${formatarSenha(t)}
              </div>
            `
          )
          .join("")
      : `
        <div class="screen-empty">
          Nenhuma senha aguardando.
        </div>
      `;

    $("callNext").disabled = !proxima || !!agora;

    $("callNext").style.opacity =
      !proxima || !!agora ? ".55" : "1";

    ["resolve", "cancelCurrent"].forEach((id) => {
      $(id).disabled = !agora;
      $(id).style.opacity = agora ? "1" : ".55";
    });

    renderTodas();
  }

  function renderTodas() {
    const term = $("searchAll").value
      .trim()
      .toLowerCase();

    const fStatus = $("filterStatus").value;
    const fPri = $("filterPriorityAll").value;

    const lista = [...filaService.tickets]
      .filter(
        (t) =>
          formatarSenha(t).includes(term) &&
          (fStatus === "todos" || t.status === fStatus) &&
          (fPri === "todas" || t.priority === fPri)
      )
      .sort((a, b) => b.order - a.order);

    $("rowsAll").innerHTML = lista
      .map((t) => {
        const st =
          STATUS[t.status] || STATUS.fila;

        const acoes =
          t.status === "fila"
            ? `
              <button
                class="row-action"
                data-call="${t.id}"
              >
                ➜ Chamar
              </button>

              <button
                class="row-action danger"
                data-cancel="${t.id}"
              >
                ✕
              </button>
            `
            : t.status === "atendimento"
            ? `
              <button
                class="row-action success"
                data-resolve="${t.id}"
              >
                ✓ Resolver
              </button>

              <button
                class="row-action danger"
                data-cancel="${t.id}"
              >
                ✕ Cancelar
              </button>
            `
            : `<span class="status">—</span>`;

        return `
          <tr>
            <td>
              <span class="id">
                ${formatarSenha(t)}
              </span>
            </td>

            <td>
              <span class="priority ${safe(t.priority)}">
                ${LABELS[t.priority]}
              </span>
            </td>

            <td>
              <span class="status ${st.cls}">
                ${st.label}
              </span>
            </td>

            <td>
              ${
                t.guiche
                  ? `
                    <span class="guiche-badge">
                      ${safe(formatarGuiche(t.guiche))}
                    </span>
                  `
                  : "—"
              }
            </td>

            <td>
              ${safe(t.time)}
            </td>

            <td>
              <div class="row-actions">
                ${acoes}
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    $("emptyAll").hidden = lista.length > 0;
  }

  function renderTelao() {
    const u = filaService.ultimaChamada();

    $("telaoNumber").textContent =
      u ? formatarSenha(u) : "----";

    $("telaoGuiche").textContent =
      u ? formatarGuiche(u.guiche) : "";

    $("telaoStatus").textContent = u
      ? "Dirija-se ao guichê indicado"
      : "Aguardando o próximo atendimento";

    const proximas = filaService.fila().slice(0, 4);

    $("telaoNextList").innerHTML = proximas.length
      ? proximas
          .map(
            (t) => `
              <div class="telao-next-item">
                <span class="telao-next-num">
                  ${formatarSenha(t)}
                </span>

                <span
                  class="telao-next-pri ${safe(t.priority)}"
                >
                  ${LABELS[t.priority]}
                </span>
              </div>
            `
          )
          .join("")
      : `
        <div class="telao-empty">
          Nenhuma senha aguardando
        </div>
      `;

    const ativos = filaService.emAtendimento();

    $("telaoActiveList").innerHTML = ativos.length
      ? ativos
          .map(
            (t) => `
              <div class="telao-next-item">
                <span class="telao-next-num">
                  ${formatarSenha(t)}
                </span>

                <span
                  class="telao-next-pri"
                  style="background:#0a2e1c;color:#34d399;"
                >
                  ${safe(formatarGuiche(t.guiche))}
                </span>
              </div>
            `
          )
          .join("")
      : `
        <div class="telao-empty">
          Nenhum atendimento ativo
        </div>
      `;

    atualizarCliente();
  }

  // ---------- wiring do painel ----------

  const VIEW_META = {
    inicio: {
      titulo: "Fila de Atendimento",
      sub: "Acompanhe as senhas e organize os atendimentos por prioridade.",
      bc: "Visão geral",
    },

    fila: {
      titulo: "Fila de Atendimento",
      sub: "Acompanhe as senhas e organize os atendimentos por prioridade.",
      bc: "Fila de atendimento",
    },

    novo: {
      titulo: "Gerar nova senha",
      sub: "Escolha o tipo de atendimento e gere a senha do cliente.",
      bc: "Nova senha",
    },

    todos: {
      titulo: "Todas as senhas",
      sub: "Histórico completo, com filtros por status e tipo.",
      bc: "Todas as senhas",
    },
  };

  function setView(v) {
    document
      .querySelectorAll(".nav button")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          b.dataset.view === v
        )
      );

    $("viewInicio")?.classList.toggle(
      "active",
      v === "inicio" || v === "fila"
    );

    $("viewNovo")?.classList.toggle(
      "active",
      v === "novo"
    );

    $("viewTodos")?.classList.toggle(
      "active",
      v === "todos"
    );

    const m =
      VIEW_META[v] || VIEW_META.inicio;

    setText("pageTitle", m.titulo);
    setText("subtitle", m.sub);
    setText("breadcrumb", m.bc);

    $("sidebar")?.classList.remove("open");
  }

  document
    .querySelectorAll(".nav button")
    .forEach((b) =>
      b.addEventListener("click", () =>
        setView(b.dataset.view)
      )
    );

  on("newTop", "click", () => {
    setView("novo");
  });

  on("mobileMenu", "click", () => {
    $("sidebar")?.classList.toggle("open");
  });

  const guicheSelect = $("guicheSelect");

  if (guicheSelect) {
    guicheSelect.value = String(guicheAtual.id);

    on("guicheSelect", "change", (e) => {
      const n = Number(e.target.value);
      if (!Number.isInteger(n) || n < 1) return;

      guicheAtual.id = n;

      try {
        localStorage.setItem(
          CHAVE_GUICHE,
          String(guicheAtual.id)
        );
      } catch {}

      setText(
        "topGuiche",
        formatarGuiche(guicheAtual.id)
      );

      refresh();
    });
  }

  setText(
    "topGuiche",
    formatarGuiche(guicheAtual.id)
  );

  setText(
    "dateText",
    new Date().toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    })
  );

  // ---------- ações do guichê ----------

  async function chamarProximo(idAlvo = null) {
    if (guicheAtual.atual) {
      return toast(
        "Finalize ou resolva o atendimento atual primeiro."
      );
    }

    try {
      const r = await guicheAtual.chamar(idAlvo);

      if (!r) {
        toast(
          idAlvo == null
            ? "Não há senha disponível para chamar."
            : "A senha selecionada não está mais na fila."
        );
      }
    } catch (err) {
      toast(
        err?.message ||
          "Não foi possível chamar a senha."
      );
    }
  }

  on("callNext", "click", () => {
    chamarProximo();
  });

  on("resolve", "click", () => {
    const a = guicheAtual.atual;

    if (a) {
      filaService
        .resolver(a.id)
        .catch(() =>
          toast("Não foi possível resolver o atendimento.")
        );
    }
  });

  on("cancelCurrent", "click", () => {
    const a = guicheAtual.atual;

    if (a) {
      filaService
        .cancelar(a.id)
        .catch(() =>
          toast("Não foi possível cancelar o atendimento.")
        );
    }
  });

  on("repeatCall", "click", () => {
    const a = guicheAtual.atual;

    if (a) {
      anunciar(a);
    } else {
      toast(
        "Nenhuma senha em atendimento no seu guichê."
      );
    }
  });

  // ---------- ações dentro das tabelas ----------

  document.addEventListener("click", (e) => {
    const call = e.target.closest("[data-call]");
    const res = e.target.closest("[data-resolve]");
    const cancel = e.target.closest("[data-cancel]");

    if (call) {
      chamarProximo(Number(call.dataset.call));
    }

    if (res) {
      filaService
        .resolver(Number(res.dataset.resolve))
        .catch(() =>
          toast("Não foi possível resolver a senha.")
        );
    }

    if (cancel) {
      filaService
        .cancelar(Number(cancel.dataset.cancel))
        .catch(() =>
          toast("Não foi possível cancelar a senha.")
        );
    }
  });

  // ---------- formulários de nova senha ----------

  for (const [formId, selectId] of [
    ["ticketForm", "priority"],
    ["ticketFormNovo", "priorityNovo"],
  ]) {
    on(formId, "submit", async (e) => {
      e.preventDefault();

      try {
        const select = $(selectId);
        if (!select) return;

        const t = await filaService.emitirSenha(select.value);

        toast(
          `Senha ${formatarSenha(t)} gerada!`
        );

        if (formId === "ticketFormNovo") {
          setView("fila");
        }
      } catch (err) {
        toast(
          err?.message ||
            "Não foi possível gerar a senha."
        );
      }
    });
  }

  // ---------- filtros ----------

  ["search", "filter"].forEach((id) => {
    on(id, "input", renderPainel);
  });

  [
    "searchAll",
    "filterStatus",
    "filterPriorityAll",
  ].forEach((id) => {
    on(id, "input", renderTodas);
  });

  on("clearResolved", "click", () => {
    filaService
      .limparResolvidos()
      .then(() =>
        toast("Resolvidos removidos.")
      )
      .catch(() =>
        toast("Não foi possível limpar os resolvidos.")
      );
  });

  // ---------- preferências de som ----------

  function refletirPrefs() {
    const sound = $("soundToggle");
    const voice = $("voiceToggle");
    const volume = $("soundVolume");
    const volumeValue = $("volumeValue");

    if (sound) {
      sound.textContent = prefs.som
        ? "🔊 Som ligado"
        : "🔇 Som desligado";

      sound.setAttribute(
        "aria-pressed",
        String(prefs.som)
      );
    }

    if (voice) voice.checked = prefs.voz;

    if (volume) {
      volume.value =
        Math.round(prefs.volume * 100);
    }

    if (volumeValue) {
      volumeValue.textContent =
        Math.round(prefs.volume * 100) + "%";
    }
  }

  on("soundToggle", "click", () => {
    prefs.som = !prefs.som;
    salvarPrefs();
    refletirPrefs();
  });

  on("voiceToggle", "change", (e) => {
    prefs.voz = e.target.checked;
    salvarPrefs();
  });

  on("soundVolume", "input", (e) => {
    prefs.volume = Math.min(
      1,
      Math.max(0, Number(e.target.value) / 100)
    );

    salvarPrefs();

    setText(
      "volumeValue",
      Math.round(prefs.volume * 100) + "%"
    );
  });

  on("testSound", "click", () => {
    beep(true);
    falar(
      "Teste de som. Tudo funcionando.",
      true
    );
  });

  refletirPrefs();

  // ---------- impressão de senha ----------

  function imprimirSenha(modo) {
    document.body.classList.add(
      modo === "cliente" ? "printing-cliente" : "printing-kiosk"
    );
    requestAnimationFrame(() => window.print());
  }

  window.addEventListener("afterprint", () => {
    document.body.classList.remove("printing-kiosk", "printing-cliente");
  });

  on("kioskPrint", "click", () => imprimirSenha("kiosk"));
  on("clientePrint", "click", () => imprimirSenha("cliente"));

  // ---------- kiosk ----------

  if (viewMode === "kiosk") {
    document
      .querySelectorAll(".kiosk-pri-btn")
      .forEach((b) => {
        b.addEventListener(
          "click",
          async () => {
            b.disabled = true;

            try {
              const t =
                await filaService.emitirSenha(
                  b.dataset.pri
                );

              const num = $("kioskNum");
              const pr = $("kioskResultPri");
              const choose = $("kioskChoose");
              const result = $("kioskResult");

              if (num) num.textContent = formatarSenha(t);

              if (pr) {
                pr.textContent = LABELS[t.priority];
                pr.className =
                  `kiosk-result-pri ${t.priority}`;
              }

              if (choose) choose.style.display = "none";
              if (result) result.classList.add("show");
            } catch (err) {
              toast(
                err?.message ||
                  "Não foi possível gerar a senha."
              );
            } finally {
              b.disabled = false;
            }
          }
        );
      });

    on("kioskAgain", "click", () => {
      $("kioskResult")?.classList.remove("show");
      if ($("kioskChoose")) {
        $("kioskChoose").style.display = "";
      }
    });
  }

  // ---------- telão: relógio ----------

  if (viewMode === "telao") {
    const tick = () => {
      setText(
        "telaoClock",
        new Date().toLocaleTimeString(
          "pt-BR",
          {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }
        )
      );
    };

    tick();

    setInterval(tick, 1000);
  }

  // ---------- acompanhamento do cliente ----------

  function encontrarPorSenha(valor) {
    const n = Number(String(valor ?? "").replace(/\D/g, ""));
    if (!Number.isInteger(n) || n < 1) return null;
    return filaService.tickets.find((t) => Number(t.senha) === n) || null;
  }

  function calcularPosicao(ticket) {
    if (!ticket || ticket.status !== "fila") return 0;
    const index = filaService.fila().findIndex((t) => t.id === ticket.id);
    return index >= 0 ? index + 1 : 0;
  }

  function atualizarCliente() {
    if (viewMode !== "cliente") return;
    const paramsSenha = params.get("senha");
    const saved = localStorage.getItem("filafacil_cliente_senha");
    const ticket = encontrarPorSenha(paramsSenha || saved);
    if (!ticket) return;

    try { localStorage.setItem("filafacil_cliente_senha", String(ticket.senha)); } catch {}

    setText("clienteSenha", `C${formatarSenha(ticket)}`);
    setText("clienteCalledSenha", `C${formatarSenha(ticket)}`);
    const unidade = `Fila SCS C${String(ticket.guiche || 1).padStart(2, "0")}`;
    setText("clienteUnidade", unidade);
    setText("clienteCalledUnit", unidade);

    const pos = calcularPosicao(ticket);
    setText("clientePosicao", pos || "—");
    setText("clienteStatusText", ticket.status === "atendimento" ? "EM ATENDIMENTO" : ticket.status === "resolvido" ? "ATENDIDO" : ticket.status === "cancelado" ? "CANCELADA" : "EM ESPERA");

    const ring = $("clienteRing");
    if (ring) {
      const percent = Math.max(8, Math.min(92, 100 - pos * 5));
      ring.style.background = `conic-gradient(#ef790d 0 ${percent}%, #e9edf2 ${percent}% 100%)`;
    }

    const called = ticket.status === "atendimento";
    const arrived = $("clienteArrived");
    if (arrived) { arrived.style.display = called ? "flex" : "none"; arrived.classList.remove("dismissed"); }
    setText("clienteMesa", called ? `🚶 ${formatarGuiche(ticket.guiche).replace("Guichê", "Mesa")}` : "Aguardando chamada");
    setText("clienteCalledCount", called ? "1" : "0");

    const elapsed = called && ticket.calledAt ? Math.max(0, Math.floor((Date.now() - ticket.calledAt) / 60000)) : 0;
    setText("clienteWait", `${elapsed} minuto${elapsed === 1 ? "" : "s"}`);
    const eta = new Date(Date.now() + Math.max(1, pos || 1) * 4 * 60000);
    setText("clienteEta", eta.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }));
  }

  if (viewMode === "cliente") {
    const input = $("clienteInput");
    const setup = $("clienteSetup");
    const senhaInicial = params.get("senha") || localStorage.getItem("filafacil_cliente_senha");

    if (input && senhaInicial) input.value = String(senhaInicial).replace(/\D/g, "").padStart(4, "0");
    if (senhaInicial && encontrarPorSenha(senhaInicial) && setup) setup.style.display = "none";

    on("clienteForm", "submit", (e) => {
      e.preventDefault();
      const value = input?.value.replace(/\D/g, "") || "";
      const ticket = encontrarPorSenha(value);
      if (!ticket) { toast("Senha não encontrada na fila."); return; }
      try { localStorage.setItem("filafacil_cliente_senha", String(ticket.senha)); } catch {}
      if (setup) setup.style.display = "none";
      atualizarCliente();
    });

    on("clienteClear", "click", () => { localStorage.removeItem("filafacil_cliente_senha"); if (setup) setup.style.display = "block"; });
    on("clienteReset", "click", () => { localStorage.removeItem("filafacil_cliente_senha"); if (setup) setup.style.display = "block"; if (input) input.value = ""; });
    on("clienteArrivedClose", "click", () => $("clienteArrived")?.classList.add("dismissed"));
  }

  // ---------- inicialização ----------

  filaService.inscrever(refresh);

  setView("inicio");
  refresh();

  window.addEventListener("pagehide", () => {
    try {
      canal?.close();
    } catch {}
  });
