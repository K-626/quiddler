export class GameRoom {
    constructor(state, env) {
        this.state = state;
        this.gameState = null; // キャッシュ用
        this.seats = null;     // { [clientId]: seatIndex }
    }

    async fetch(request) {
        const upgradeHeader = request.headers.get("Upgrade");
        if (upgradeHeader !== "websocket") {
            return new Response("Expected Upgrade: websocket", { status: 426 });
        }

        const url = new URL(request.url);
        const clientId = url.searchParams.get("client") || ("anon-" + Math.random().toString(36).slice(2, 9));
        const playerName = url.searchParams.get("name") ? decodeURIComponent(url.searchParams.get("name")).trim() : null;

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        this.state.acceptWebSocket(server, [clientId]);

        // storageから復元
        if (!this.gameState) {
            this.gameState = await this.state.storage.get("gameState");
        }
        if (!this.seats) {
            this.seats = (await this.state.storage.get("seats")) || {};
        }

        // 席の割り当て
        const reqSeat = url.searchParams.get("seat");
        let seat = undefined;

        if (reqSeat !== null && reqSeat !== "" && reqSeat !== "auto") {
            const parsed = parseInt(reqSeat, 10);
            if (!isNaN(parsed)) {
                seat = parsed;
                this.seats[clientId] = seat;
                await this.state.storage.put("seats", this.seats);
            }
        }

        // 現在アクティブな接続のclientIdを取得
        const activeClients = new Set();
        for (const ws of this.state.getWebSockets()) {
            const tags = this.state.getTags(ws) || [];
            for (const t of tags) activeClients.add(t);
        }

        // 接続中の他クライアントが持っている席
        const takenSeats = new Set();
        for (const [cId, sIdx] of Object.entries(this.seats)) {
            if (cId !== clientId && activeClients.has(cId) && sIdx >= 0) {
                takenSeats.add(sIdx);
            }
        }

        if (seat === undefined) {
            const prevSeat = this.seats[clientId];
            // 以前の席が生きていて、他の接続中クライアントに取られていなければ復帰
            if (prevSeat !== undefined && (prevSeat < 0 || !takenSeats.has(prevSeat))) {
                seat = prevSeat;
            }
        }

        // それでも未割り当ての場合は空き席を自動検索
        if (seat === undefined) {
            const maxPlayers = this.gameState ? this.gameState.n : 4;
            let assignedSeat = -1; // デフォルトは観戦
            for (let i = 0; i < maxPlayers; i++) {
                if (!takenSeats.has(i)) {
                    assignedSeat = i;
                    break;
                }
            }
            this.seats[clientId] = assignedSeat;
            await this.state.storage.put("seats", this.seats);
            seat = assignedSeat;
        }

        // プレイヤー名が指定されていて、着席している場合はゲーム状態に名前を反映
        if (playerName && seat >= 0 && this.gameState && this.gameState.players && this.gameState.players[seat]) {
            this.gameState.players[seat].name = playerName;
            await this.state.storage.put("gameState", this.gameState);
            // 他の接続者に更新を通知
            for (const sock of this.state.getWebSockets()) {
                if (sock !== server) {
                    sock.send(JSON.stringify({ state: this.gameState }));
                }
            }
        }

        // 初期情報（割り当てられた席と現在のゲーム状態）を送信
        server.send(JSON.stringify({
            type: "welcome",
            seat: seat,
            state: this.gameState
        }));

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    async webSocketMessage(ws, msg_str) {
        try {
            const data = JSON.parse(msg_str);

            if (data.type === "init") {
                // 新規ゲーム作成時：作成者を指定席（デフォルト0）にし、席マップを初期化
                const targetSeat = (data.seat !== undefined && data.seat !== null && data.seat !== "auto") ? parseInt(data.seat, 10) : 0;
                if (data.clientId) {
                    this.seats = { [data.clientId]: targetSeat };
                    await this.state.storage.put("seats", this.seats);
                    ws.send(JSON.stringify({ type: "welcome", seat: targetSeat, state: data.state }));
                }
                if (data.state) {
                    this.gameState = data.state;
                    await this.state.storage.put("gameState", this.gameState);
                }
                // 送信元を除く全員にブロードキャスト
                for (const sock of this.state.getWebSockets()) {
                    if (sock !== ws) {
                        sock.send(JSON.stringify({ state: this.gameState }));
                    }
                }
            } else if (data.type === "action") {
                if (data.state) {
                    this.gameState = data.state;
                    await this.state.storage.put("gameState", this.gameState);
                }
                for (const sock of this.state.getWebSockets()) {
                    if (sock !== ws) {
                        sock.send(JSON.stringify({ state: this.gameState }));
                    }
                }
            } else if (data.type === "get") {
                const saved = this.gameState ?? (await this.state.storage.get("gameState"));
                if (saved) {
                    this.gameState = saved;
                    ws.send(JSON.stringify({ state: saved }));
                }
            } else if (data.type === "set_seat") {
                const targetSeat = parseInt(data.seat, 10);
                if (!isNaN(targetSeat) && data.clientId) {
                    if (!this.seats) this.seats = {};
                    this.seats[data.clientId] = targetSeat;
                    await this.state.storage.put("seats", this.seats);
                    if (data.name && targetSeat >= 0 && this.gameState && this.gameState.players && this.gameState.players[targetSeat]) {
                        this.gameState.players[targetSeat].name = data.name;
                        await this.state.storage.put("gameState", this.gameState);
                    }
                    ws.send(JSON.stringify({ type: "welcome", seat: targetSeat, state: this.gameState }));
                    for (const sock of this.state.getWebSockets()) {
                        if (sock !== ws) {
                            sock.send(JSON.stringify({ state: this.gameState }));
                        }
                    }
                }
            } else if (data.type === "set_name") {
                const targetSeat = parseInt(data.seat, 10);
                if (!isNaN(targetSeat) && targetSeat >= 0 && data.name && this.gameState && this.gameState.players && this.gameState.players[targetSeat]) {
                    this.gameState.players[targetSeat].name = String(data.name).trim();
                    await this.state.storage.put("gameState", this.gameState);
                    for (const sock of this.state.getWebSockets()) {
                        sock.send(JSON.stringify({ state: this.gameState }));
                    }
                }
            }
        } catch (err) {
            ws.send(JSON.stringify({ error: err.message }));
        }
    }

    webSocketError(ws, error) {
        console.error("WebSocket error:", error);
        ws.close(1011, "WebSocket error");
    }

    webSocketClose(ws, code, reason, wasClean) {
        // ライブラリ側で管理
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const roomName = url.searchParams.get("room") || "default-room";

        const id = env.GAME_ROOM.idFromName(roomName);
        const stub = env.GAME_ROOM.get(id);

        return stub.fetch(request);
    },
};
