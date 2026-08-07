// Copy this file into each Phaser game repo as src/bridge.ts

interface BetRequest {
  game: string
  stake: number
  gameParams: Record<string, unknown>
  clientSeed: string
}

interface BetResult {
  result: Record<string, unknown>
  win: boolean
  payout: number
  multiplier: number
  newBalance: number
  serverSeed: string
  serverSeedHash: string
  nonce: number
}

type BetResultCallback = (result: BetResult) => void
type ErrorCallback = (message: string) => void
type ReadyCallback = (balance: number) => void

class CasinoBridge {
  private token: string | null = null
  private onBetResult: BetResultCallback | null = null
  private onError: ErrorCallback | null = null
  private onReady: ReadyCallback | null = null
  private parentOrigin: string

  constructor(parentOrigin: string) {
    this.parentOrigin = parentOrigin
    window.addEventListener('message', this.handleMessage.bind(this))
    this.sendToParent('GAME_READY', {})
  }

  private handleMessage(event: MessageEvent) {
    if (event.origin !== this.parentOrigin) return
    const { type, payload } = event.data
    if (type === 'AUTH_TOKEN') {
      this.token = payload.token
      this.onReady?.(payload.balance)
    }
    if (type === 'BET_RESULT') {
      this.onBetResult?.(payload as BetResult)
    }
    if (type === 'BET_ERROR') {
      this.onError?.(payload.message)
    }
  }

  private sendToParent(type: string, payload: unknown) {
    window.parent.postMessage({ type, payload }, this.parentOrigin)
  }

  placeBet(request: BetRequest) {
    if (!this.token) {
      this.onError?.('Not authenticated')
      return
    }
    this.sendToParent('BET_REQUEST', request)
  }

  /**
   * Call this the MOMENT the game visually reveals win/loss to the player —
   * i.e. exactly where the game currently plays its win/loss sound and shows
   * the result overlay/text. Not before (the spin/roll/reel animation must
   * have actually finished on screen), not after (no need to wait for a
   * "play again" button or anything past the reveal itself).
   *
   * The parent page previously updated the visible balance (and, for a win,
   * popped a "You won ₦X!" toast) the INSTANT the /casino/play response came
   * back — which is before this game's own reveal animation ever plays. A
   * player watching the balance readout in the persistent top bar (which
   * sits outside this iframe and is always visible) could tell whether
   * they'd won before the wheel/dice/reel/cards finished animating. The
   * parent now holds the true post-result balance until it receives this
   * signal, so call it as soon as the outcome is actually shown — delaying
   * it further doesn't help fairness, only makes the UI feel slower.
   *
   * If a game never calls this, the parent falls back to revealing the
   * result on its own timer after a few seconds, so nothing hard-breaks —
   * but the leak this exists to close comes back for that game until it
   * calls this at the right moment.
   */
  revealComplete() {
    this.sendToParent('REVEAL_COMPLETE', {})
  }

  onResult(cb: BetResultCallback) { this.onBetResult = cb }
  onErr(cb: ErrorCallback) { this.onError = cb }
  onInit(cb: ReadyCallback) { this.onReady = cb }
  getToken() { return this.token }
  isAuthenticated() { return !!this.token }
}

export { CasinoBridge }
export type { BetRequest, BetResult }
