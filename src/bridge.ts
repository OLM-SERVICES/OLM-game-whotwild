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

  onResult(cb: BetResultCallback) { this.onBetResult = cb }
  onErr(cb: ErrorCallback) { this.onError = cb }
  onInit(cb: ReadyCallback) { this.onReady = cb }
  getToken() { return this.token }
  isAuthenticated() { return !!this.token }
}

export { CasinoBridge }
export type { BetRequest, BetResult }