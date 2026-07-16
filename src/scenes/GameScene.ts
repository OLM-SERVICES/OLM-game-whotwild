import Phaser from 'phaser'

import { CasinoBridge } from '../bridge'
import type { BetRequest, BetResult } from '../bridge'

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

type CardLabel = 'BALL' | 'TRIANGLE' | 'CROSS' | 'SQUARE' | 'STAR' | 'WHOT20'

interface PlaceBetPayload {
  pick:  CardLabel
  stake: number
}

// Shape of the game-specific object the backend's whotWild() function
// returns inside BetResult.result. Adjust field names here if your
// backend's JSON differs from what the game-logic doc specified.
interface WhotWildResultData {
  drawnCard:  CardLabel
  playerPick: CardLabel
}

// What the flip/reveal animation actually needs — assembled from the
// top-level BetResult fields plus the nested result data.
interface DrawOutcome {
  drawnCard:  CardLabel
  win:        boolean
  payout:     number
  multiplier: number
}

// ── VISUAL DESIGN TABLE ───────────────────────────────────────────────────
// Real Whot decks print each suit as a bold single-color shape (circle,
// triangle, cross, square, star) on a cream card face, with a small
// corner-repeat top-left and (mirrored) bottom-right. WHOT20 is the odd
// card out — a black/gold "wild" card with its own wordmark. We keep that
// visual grammar but push the palette toward the OLMBET cover art
// (gold + orange lightning on near-black), so backs/FX feel branded while
// fronts still read as "a Whot card" at a glance.
type ShapeKind = 'circle' | 'triangle' | 'cross' | 'square' | 'star' | 'whot20'

interface CardStyle {
  shape:  ShapeKind
  color:  number   // suit / accent color (used for icon fill + border)
  abbr:   string    // corner glyph
}

const CARD_DISPLAY: Record<CardLabel, CardStyle> = {
  BALL:     { shape: 'circle',   color: 0x18b46a, abbr: '●' },
  TRIANGLE: { shape: 'triangle', color: 0xe0392b, abbr: '▲' },
  CROSS:    { shape: 'cross',    color: 0x2f7fe0, abbr: '✚' },
  SQUARE:   { shape: 'square',   color: 0x1c1c1c, abbr: '■' },
  STAR:     { shape: 'star',     color: 0x8e2fd6, abbr: '★' },
  WHOT20:   { shape: 'whot20',   color: 0xffd700, abbr: '20' },
}

const CREAM   = 0xfaf3e0
const CREAM_SHADOW = 0xe9dcb8
const INK     = 0x1a1208
const GOLD    = 0xffd700
const GOLD_DIM = 0xb8860b
const ORANGE  = 0xff8a00
const NIGHT   = 0x05001a
const NIGHT_2 = 0x120033
const WIN_GREEN = 0x00e676
const LOSE_RED  = 0xff3b30

const SOUND_KEYS = {
  background: 'background-whotwild',
  select:     'select-whotwild',
  bet:        'bet-whotwild',
  flip:       'flip-whotwild',
  win:        'win-whotwild',
  winBig:     'winbig-whotwild',
  lose:       'lose-whotwild',
  tick:       'tick-whotwild',
} as const

// The CasinoBridge constructor requires the parent frontend's origin and
// strictly checks event.origin against it — a wrong value here means every
// message from the parent gets silently dropped. document.referrer works
// when the game is actually embedded in an iframe on the frontend site.
// TODO: if that's ever empty/unreliable in your setup (e.g. some browsers
// omit referrer), replace the fallback below with your real production
// frontend origin, e.g. 'https://olmbet.ng'.
function resolveParentOrigin(): string {
  try {
    if (document.referrer) return new URL(document.referrer).origin
  } catch {
    // fall through to fallback below
  }
  return window.location.origin
}

export class GameScene extends Phaser.Scene {
  // Card containers
  private cardBack!:  Phaser.GameObjects.Container
  private cardFront!: Phaser.GameObjects.Container

  // Card back visuals
  private backBase!:   Phaser.GameObjects.Graphics
  private backBadge!:  Phaser.GameObjects.Text

  // Card front visuals (redrawn per outcome)
  private frontBg!:        Phaser.GameObjects.Graphics
  private frontIcon!:      Phaser.GameObjects.Graphics
  private frontWordmark!:  Phaser.GameObjects.Text
  private cardFrontGlow!:  Phaser.GameObjects.Rectangle
  private cornerTL!: Phaser.GameObjects.Container
  private cornerBR!: Phaser.GameObjects.Container
  private cornerTLIcon!: Phaser.GameObjects.Graphics
  private cornerBRIcon!: Phaser.GameObjects.Graphics
  private cornerTLText!: Phaser.GameObjects.Text
  private cornerBRText!: Phaser.GameObjects.Text

  private statusText!: Phaser.GameObjects.Text
  private resultBanner!: Phaser.GameObjects.Text

  private bgMusic!:   Phaser.Sound.BaseSound
  private sounds:     Partial<Record<keyof typeof SOUND_KEYS, Phaser.Sound.BaseSound>> = {}

  private bridge!: CasinoBridge
  private isResolving = false

  private cardCX = 0
  private cardCY = 0

  constructor() {
    super({ key: 'GameScene' })
  }

  // ── PRELOAD ────────────────────────────────────────────────────────────
  preload() {
    Object.values(SOUND_KEYS).forEach((key) => {
      this.load.audio(key, `/sounds/${key}.mp3`)
    })
    // No external art — every visual in this scene (card faces, backs,
    // particles, lightning) is drawn procedurally with Graphics below so
    // there's nothing else to preload.
  }

  // ── CREATE ─────────────────────────────────────────────────────────────
  create() {
    const { width, height } = this.scale

    this.cameras.main.setBackgroundColor(`#${NIGHT.toString(16).padStart(6, '0')}`)

    this.cardCX = width / 2
    this.cardCY = height / 2

    this.generateParticleTextures()
    this.setupSounds()
    this.setupBackgroundAmbience(width, height)
    this.setupCard(this.cardCX, this.cardCY)
    this.setupStatusText(width, height)

    this.startBackgroundMusic()
    this.setupBridge()
    this.setupPanelListener()

    // NOTE: CasinoBridge sends GAME_READY itself in its constructor —
    // do not send it again here or the parent will double-init.
  }

  // ── PROCEDURAL PARTICLE TEXTURES ─────────────────────────────────────────
  // Generated once at boot so the win/loss FX below can spawn cheap sprite
  // particles instead of drawing hundreds of Graphics objects per frame.
  private generateParticleTextures() {
    // Gold coin
    const coin = this.make.graphics({ x: 0, y: 0 }, false)
    coin.fillStyle(GOLD, 1)
    coin.fillCircle(10, 10, 9)
    coin.lineStyle(2, GOLD_DIM, 1)
    coin.strokeCircle(10, 10, 9)
    coin.fillStyle(0xfff3b0, 0.9)
    coin.fillCircle(10, 10, 4)
    coin.generateTexture('fx-coin', 20, 20)
    coin.destroy()

    // Warm spark (used for win bursts)
    const spark = this.make.graphics({ x: 0, y: 0 }, false)
    spark.fillStyle(GOLD, 1)
    spark.fillCircle(5, 5, 5)
    spark.fillStyle(0xffffff, 0.9)
    spark.fillCircle(5, 5, 2)
    spark.generateTexture('fx-spark', 10, 10)
    spark.destroy()

    // Red ember (used for loss)
    const ember = this.make.graphics({ x: 0, y: 0 }, false)
    ember.fillStyle(LOSE_RED, 1)
    ember.fillCircle(4, 4, 4)
    ember.fillStyle(0x330000, 0.6)
    ember.fillCircle(4, 4, 1.5)
    ember.generateTexture('fx-ember', 8, 8)
    ember.destroy()

    // Soft warm dust mote (used for the ambient background drift)
    const dust = this.make.graphics({ x: 0, y: 0 }, false)
    dust.fillStyle(GOLD, 1)
    dust.fillCircle(3, 3, 3)
    dust.generateTexture('fx-dust', 6, 6)
    dust.destroy()
  }

  // Faint, slow-drifting gold dust rising behind the card — a quiet nod to
  // the cover art's warm glow without any bolts or flashes near the card.
  // Sits at depth -1 so it never renders in front of the card or UI text.
  private setupBackgroundAmbience(width: number, height: number) {
    const emitter = this.add.particles(0, 0, 'fx-dust', {
      x: { min: 0, max: width },
      y: height + 10,
      lifespan: 7000,
      speedY: { min: -14, max: -28 },
      speedX: { min: -6, max: 6 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.22, end: 0 },
      frequency: 420,
      quantity: 1,
    })
    emitter.setDepth(-1)
  }

  // ── SOUND SETUP ─────────────────────────────────────────────────────────
  private setupSounds() {
    // Phaser mutes/pauses ALL sound by default whenever the iframe's window
    // loses focus (this.sound.pauseOnBlur defaults to true). Since the
    // stake input, quick-stake buttons, and PLAY button all live in the
    // React panel OUTSIDE this iframe, every interaction with them shifts
    // focus away and would otherwise cut the background music and block
    // any .play() calls made afterward (tick/win/lose sounds). Must be set
    // before anything is played.
    this.sound.pauseOnBlur = false

    this.bgMusic = this.sound.add(SOUND_KEYS.background, { loop: true, volume: 0.35 })

    this.sounds.select = this.sound.add(SOUND_KEYS.select,  { volume: 0.6 })
    this.sounds.bet    = this.sound.add(SOUND_KEYS.bet,     { volume: 0.7 })
    this.sounds.flip   = this.sound.add(SOUND_KEYS.flip,    { volume: 0.8 })
    this.sounds.win    = this.sound.add(SOUND_KEYS.win,     { volume: 0.8 })
    this.sounds.winBig = this.sound.add(SOUND_KEYS.winBig,  { volume: 0.9 })
    this.sounds.lose   = this.sound.add(SOUND_KEYS.lose,    { volume: 0.6 })
    this.sounds.tick   = this.sound.add(SOUND_KEYS.tick,    { volume: 0.5 })
  }

  private startBackgroundMusic() {
    // Most browsers block audio until a user gesture. Try immediately;
    // if blocked, resume on first pointer interaction anywhere in the canvas.
    if (this.sound.locked) {
      this.sound.once(Phaser.Sound.Events.UNLOCKED, () => this.bgMusic.play())
    } else {
      this.bgMusic.play()
    }
  }

  // ── CARD SHELL ───────────────────────────────────────────────────────────
  private setupCard(cx: number, cy: number) {
    this.buildCardBack(cx, cy)
    this.buildCardFront(cx, cy)

    // Idle floating animation on the face-down card while waiting
    this.tweens.add({
      targets: this.cardBack,
      y: cy - 8,
      duration: 1400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  // Card back: calm near-black plate with a single clean gold border and a
  // softly breathing badge in the center — no bolts or seams on the card
  // itself, keeping focus on the face reveal.
  private buildCardBack(cx: number, cy: number) {
    const w = 168
    const h = 232

    this.cardBack = this.add.container(cx, cy)

    this.backBase = this.add.graphics()
    this.paintBackBase(this.backBase, w, h)

    this.backBadge = this.add.text(0, 0, '?', {
      fontSize: '46px',
      color: '#ffd700',
      fontStyle: 'bold',
    }).setOrigin(0.5)

    const ring = this.add.circle(0, 0, 44, 0x000000, 0)
      .setStrokeStyle(2, GOLD, 0.6)

    this.cardBack.add([this.backBase, ring, this.backBadge])

    // Gentle glow breathing on the badge ring to keep the back quietly "alive"
    this.tweens.add({
      targets: ring,
      alpha: { from: 0.6, to: 0.2 },
      duration: 1600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  private paintBackBase(g: Phaser.GameObjects.Graphics, w: number, h: number) {
    g.clear()
    g.fillStyle(NIGHT_2, 1)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, 14)
    g.lineStyle(3, GOLD, 0.85)
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, 14)
  }

  // Jagged lightning-bolt stroke from (x,y) toward a rough end offset —
  // used only for the celebratory win-screen flashes and loss cracks below,
  // never drawn on the card itself.
  // with a soft wide glow pass underneath a bright core pass.
  private drawLightningPath(
    g: Phaser.GameObjects.Graphics,
    x: number, y: number, dx: number, dy: number,
    color: number, thickness: number, alpha: number,
  ) {
    const segments = 5
    const pts: Phaser.Math.Vector2[] = [new Phaser.Math.Vector2(x, y)]
    for (let i = 1; i <= segments; i++) {
      const t = i / segments
      const jitter = Phaser.Math.Between(-10, 10)
      pts.push(new Phaser.Math.Vector2(
        x + dx * t * segments * 4 + jitter,
        y + dy * t * segments * 4 + jitter,
      ))
    }
    g.lineStyle(thickness + 3, color, alpha * 0.35)
    g.strokePoints(pts, false)
    g.lineStyle(thickness, 0xffffff, alpha)
    g.strokePoints(pts, false)
  }

  // Card front shell: cream plate + suit icon + corner repeats + a glow
  // rect used for the win/loss flash. Face content is (re)painted per
  // outcome by renderCardFace().
  private buildCardFront(cx: number, cy: number) {
    const w = 160, h = 220

    this.cardFront = this.add.container(cx, cy)

    this.frontBg = this.add.graphics()
    this.frontIcon = this.add.graphics()
    this.frontWordmark = this.add.text(0, -70, '', {
      fontSize: '22px',
      fontStyle: 'bold',
      color: '#ffd700',
    }).setOrigin(0.5)

    this.cardFrontGlow = this.add.rectangle(0, 0, w + 10, h + 10, 0xffffff, 0)
      .setStrokeStyle(4, 0xffffff, 0)

    this.cornerTLIcon = this.add.graphics()
    this.cornerTLText = this.add.text(10, 0, '', { fontSize: '13px', fontStyle: 'bold', color: '#1a1208' }).setOrigin(0, 0.5)
    this.cornerTL = this.add.container(-w / 2 + 14, -h / 2 + 16, [this.cornerTLIcon, this.cornerTLText])

    this.cornerBRIcon = this.add.graphics()
    this.cornerBRText = this.add.text(10, 0, '', { fontSize: '13px', fontStyle: 'bold', color: '#1a1208' }).setOrigin(0, 0.5)
    this.cornerBR = this.add.container(w / 2 - 14, h / 2 - 16, [this.cornerBRIcon, this.cornerBRText])
    this.cornerBR.setAngle(180) // mirrors like a real card's bottom-right corner index

    this.cardFront.add([
      this.frontBg, this.frontIcon, this.frontWordmark,
      this.cornerTL, this.cornerBR, this.cardFrontGlow,
    ])
    this.cardFront.setVisible(false)
    this.cardFront.setScale(1, 1)
  }

  // Paints the front face for a given card label: cream Whot-style suit
  // card, or the black/gold WHOT20 wild card.
  private renderCardFace(card: CardLabel) {
    const style = CARD_DISPLAY[card]
    const w = 160, h = 220
    const isWild = card === 'WHOT20'

    this.frontBg.clear()
    if (isWild) {
      this.frontBg.fillStyle(0x0c0c0c, 1)
      this.frontBg.fillRoundedRect(-w / 2, -h / 2, w, h, 14)
      this.frontBg.lineStyle(3, GOLD, 1)
      this.frontBg.strokeRoundedRect(-w / 2, -h / 2, w, h, 14)
    } else {
      this.frontBg.fillStyle(CREAM_SHADOW, 1)
      this.frontBg.fillRoundedRect(-w / 2 + 1, -h / 2 + 2, w, h, 14)
      this.frontBg.fillStyle(CREAM, 1)
      this.frontBg.fillRoundedRect(-w / 2, -h / 2, w, h, 14)
      this.frontBg.lineStyle(3, style.color, 0.9)
      this.frontBg.strokeRoundedRect(-w / 2, -h / 2, w, h, 14)
    }

    this.frontWordmark.setText(isWild ? 'W H O T' : '')

    this.frontIcon.clear()
    if (isWild) {
      // Big red "20" with a gold flame accent, WHOT20-style
      this.frontIcon.fillStyle(0xff3b30, 1)
      this.frontIcon.fillCircle(0, 12, 46)
      this.frontIcon.lineStyle(3, GOLD, 1)
      this.frontIcon.strokeCircle(0, 12, 46)
    } else {
      this.drawShape(this.frontIcon, style.shape, 0, 6, 46, style.color)
    }

    // Corner repeats
    this.paintCorner(this.cornerTLIcon, this.cornerTLText, style, isWild)
    this.paintCorner(this.cornerBRIcon, this.cornerBRText, style, isWild)
  }

  private paintCorner(
    icon: Phaser.GameObjects.Graphics,
    text: Phaser.GameObjects.Text,
    style: CardStyle,
    isWild: boolean,
  ) {
    icon.clear()
    if (isWild) {
      icon.fillStyle(GOLD, 1)
      icon.fillCircle(0, 0, 8)
      text.setColor('#ffd700').setText('20')
    } else {
      this.drawShape(icon, style.shape, 0, 0, 8, style.color)
      text.setColor(`#${INK.toString(16).padStart(6, '0')}`).setText('')
    }
  }

  // Generic suit-shape renderer used for both the big center icon and the
  // small corner repeats, matching real Whot card iconography.
  private drawShape(
    g: Phaser.GameObjects.Graphics, shape: ShapeKind,
    cx: number, cy: number, size: number, color: number,
  ) {
    g.fillStyle(color, 1)
    switch (shape) {
      case 'circle':
        g.fillCircle(cx, cy, size)
        break
      case 'square':
        g.fillRoundedRect(cx - size, cy - size, size * 2, size * 2, size * 0.25)
        break
      case 'triangle':
        g.fillTriangle(
          cx, cy - size,
          cx - size * 0.95, cy + size * 0.8,
          cx + size * 0.95, cy + size * 0.8,
        )
        break
      case 'cross':
        g.fillRect(cx - size, cy - size * 0.32, size * 2, size * 0.64)
        g.fillRect(cx - size * 0.32, cy - size, size * 0.64, size * 2)
        break
      case 'star':
        g.fillPoints(this.starPoints(cx, cy, size, size * 0.42, 5), true)
        break
      case 'whot20':
        g.fillCircle(cx, cy, size)
        break
    }
  }

  private starPoints(cx: number, cy: number, outerR: number, innerR: number, points: number) {
    const pts: Phaser.Math.Vector2[] = []
    const step = Math.PI / points
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR
      const angle = -Math.PI / 2 + i * step
      pts.push(new Phaser.Math.Vector2(cx + r * Math.cos(angle), cy + r * Math.sin(angle)))
    }
    return pts
  }

  private setupStatusText(width: number, height: number) {
    this.statusText = this.add.text(width / 2, height - 40, 'Pick a card type below', {
      fontSize: '15px',
      color: '#ffffff88',
      fontStyle: '600',
    }).setOrigin(0.5)

    this.resultBanner = this.add.text(width / 2, 60, '', {
      fontSize: '20px',
      fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setAlpha(0)
  }

  // ── CASINO BRIDGE (auth, BET_REQUEST/BET_RESULT/BET_ERROR) ────────────────
  private setupBridge() {
    this.bridge = new CasinoBridge(resolveParentOrigin())

    this.bridge.onInit((_balance) => {
      // Balance display lives in the React panel, not the canvas — nothing
      // to render here, but this fires once AUTH_TOKEN arrives, confirming
      // the bridge is authenticated and placeBet() is safe to call.
    })

    this.bridge.onResult((result) => this.handleBetResult(result))
    this.bridge.onErr((message) => this.handleBetError(message))
  }

  // ── PANEL MESSAGES (PICK_SELECTED / PLACE_BET from the React panel) ──────
  private setupPanelListener() {
    window.addEventListener('message', this.handlePanelMessage)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener('message', this.handlePanelMessage)
    })
  }

  private handlePanelMessage = (event: MessageEvent) => {
    const { type, payload } = event.data || {}

    if (type === 'PICK_SELECTED' && payload?.pick) {
      // Panel is the source of truth for the pick — this is visual feedback only.
      this.onPickHighlighted(payload.pick as CardLabel)
    }

    if (type === 'PLACE_BET' && payload?.pick && payload?.stake) {
      this.onPlaceBet(payload as PlaceBetPayload)
    }
  }

  private sendToParent(type: string, payload: unknown) {
    window.parent.postMessage({ type, payload }, '*')
  }

  // ── PICK HIGHLIGHT (from panel, no bet placed yet) ───────────────────────
  private onPickHighlighted(pick: CardLabel) {
    if (this.isResolving) return
    this.sounds.select?.play()
    this.statusText.setText(`Selected: ${CARD_DISPLAY[pick].abbr} ${pick === 'WHOT20' ? 'WHOT 20' : pick} — tap PLAY to draw`)

    // Small pulse on the card back to acknowledge the pick
    this.tweens.add({
      targets: this.cardBack,
      scale: 1.06,
      duration: 120,
      yoyo: true,
      ease: 'Quad.easeOut',
    })
  }

  // ── PLACE BET — fires BET_REQUEST via the bridge, result comes back async ─
  private onPlaceBet(payload: PlaceBetPayload) {
    if (this.isResolving) return
    this.isResolving = true

    this.sounds.bet?.play()
    this.statusText.setText('Drawing card...')
    this.resultBanner.setAlpha(0)

    const request: BetRequest = {
      game: 'WHOT_WILD', // must match the backend's gameRegistry key exactly
      stake: payload.stake,
      gameParams: { playerPick: payload.pick }, // backend's validate()/play() read params.playerPick, not params.pick
      clientSeed: generateClientSeed(),
    }

    this.bridge.placeBet(request)
  }

  // ── BRIDGE CALLBACKS ───────────────────────────────────────────────────────
  private handleBetResult(result: BetResult) {
    const data = result.result as unknown as WhotWildResultData

    const outcome: DrawOutcome = {
      drawnCard:  data.drawnCard,
      win:        result.win,
      payout:     result.payout,
      multiplier: result.multiplier,
    }

    this.playFlipAnimation(outcome).then(() => {
      this.sendToParent('BET_DONE', { newBalance: result.newBalance })
      this.isResolving = false
    })
  }

  private handleBetError(message: string) {
    console.error('[whot-wild] bet error:', message)
    this.statusText.setText('Something went wrong — try again')
    this.sendToParent('PICK_CANCELLED', {})
    this.isResolving = false
  }

  // ── SHUFFLE (bridge riffle before the flip) ───────────────────────────────
  // A three-beat riffle shuffle, modeled on how a real dealer bridges a deck:
  //   1) SPLIT    — the stack divides into two piles that slide apart
  //   2) BRIDGE   — each pile arcs slightly, like cards held under thumb
  //      pressure just before release
  //   3) INTERLEAVE — cards snap back to center alternating left/right,
  //      staggered so each one lands with its own little "tick", instead of
  //      the whole deck moving as one block
  // this.cardBack is hidden for the duration and restored once the stack
  // settles, so playFlipAnimation() picks up exactly where it did before.
  private playShuffleAnimation(): Promise<void> {
    return new Promise((resolve) => {
      const cx = this.cardCX
      const cy = this.cardCY
      const w = 168
      const h = 232
      const stackSize = 10 // even, so it splits into two equal piles

      this.cardBack.setVisible(false)

      // Build the stack of face-down clones, centered and layered by depth.
      const clones: Phaser.GameObjects.Container[] = []
      for (let i = 0; i < stackSize; i++) {
        const clone = this.add.container(cx, cy)
        const g = this.add.graphics()
        this.paintBackBase(g, w, h)
        clone.add(g)
        clone.setDepth(i)
        clones.push(clone)
      }

      // Alternate which pile each card starts in (even depth → left,
      // odd depth → right) so the interleave at the end reassembles into
      // a believable riffled order, not two stacks glued back together.
      const leftPile  = clones.filter((_, i) => i % 2 === 0)
      const rightPile = clones.filter((_, i) => i % 2 !== 0)
      const half = leftPile.length

      // ── PHASE 1: SPLIT + BRIDGE ────────────────────────────────────────
      const bridgeOffsetX = 46
      const bridgeLift    = 22
      const splitDuration = 260

      this.sounds.tick?.play()

      const splitPromises: Promise<void>[] = []

      leftPile.forEach((card, idx) => {
        splitPromises.push(new Promise((res) => {
          this.tweens.add({
            targets: card,
            x: cx - bridgeOffsetX - idx * 2,
            y: cy - bridgeLift + idx * 2.5,
            angle: -8 - idx * 1.1,
            duration: splitDuration,
            delay: idx * 16,
            ease: 'Sine.easeOut',
            onComplete: () => res(),
          })
        }))
      })

      rightPile.forEach((card, idx) => {
        splitPromises.push(new Promise((res) => {
          this.tweens.add({
            targets: card,
            x: cx + bridgeOffsetX + idx * 2,
            y: cy - bridgeLift + idx * 2.5,
            angle: 8 + idx * 1.1,
            duration: splitDuration,
            delay: idx * 16,
            ease: 'Sine.easeOut',
            onComplete: () => res(),
          })
        }))
      })

      Promise.all(splitPromises).then(() => {
        // ── PHASE 2: INTERLEAVE ──────────────────────────────────────────
        // Release cards alternately from each pile back to center, staggered
        // so it reads as a real "brrrrt" riffle. Back.easeOut gives each
        // card a small confident snap on landing rather than a plain drift.
        const order: Phaser.GameObjects.Container[] = []
        for (let i = 0; i < half; i++) {
          order.push(rightPile[half - 1 - i])
          order.push(leftPile[half - 1 - i])
        }
        order.forEach((card, i) => card.setDepth(i))

        const interleaveStagger = 42
        const interleavePromises: Promise<void>[] = []

        order.forEach((card, i) => {
          interleavePromises.push(new Promise((res) => {
            this.time.delayedCall(i * interleaveStagger, () => {
              this.sounds.tick?.play()
              this.tweens.add({
                targets: card,
                x: cx - (order.length - 1 - i) * 0.3,
                y: cy + (order.length - 1 - i) * 0.5,
                angle: 0,
                duration: 200,
                ease: 'Back.easeOut',
                onComplete: () => res(),
              })
            })
          }))
        })

        Promise.all(interleavePromises).then(() => {
          // ── PHASE 3: SETTLE ────────────────────────────────────────────
          // A quick collective squash sells the "deck just landed" beat
          // before cleanup hands back to the real cardBack.
          this.tweens.add({
            targets: clones,
            scale: { from: 1.04, to: 1 },
            duration: 140,
            ease: 'Quad.easeOut',
            onComplete: () => {
              clones.forEach((c) => c.destroy())
              this.cardBack.setPosition(cx, cy)
              this.cardBack.setAngle(0)
              this.cardBack.setScale(1, 1)
              this.cardBack.setVisible(true)
              resolve()
            },
          })
        })
      })
    })
  }

  // ── FLIP + REVEAL ─────────────────────────────────────────────────────────
  private playFlipAnimation(outcome: DrawOutcome): Promise<void> {
    return new Promise((resolve) => {
      // Shuffle beat before the flip
      this.playShuffleAnimation().then(() => {
        // Short anticipation beat before the flip
        this.sounds.tick?.play()

        this.tweens.add({
          targets: this.cardBack,
          scaleX: 0,
          duration: 180,
          delay: 260,
          ease: 'Quad.easeIn',
          onComplete: () => {
            this.cardBack.setVisible(false)
            this.sounds.flip?.play()

            this.renderCardFace(outcome.drawnCard)
            this.cardFront.setVisible(true)
            this.cardFront.setScale(0, 1)
            this.cardFront.setAlpha(1)
            this.cardFront.setAngle(0)

            this.tweens.add({
              targets: this.cardFront,
              scaleX: 1,
              duration: 180,
              ease: 'Quad.easeOut',
              onComplete: () => this.showResult(outcome, resolve),
            })
          },
        })
      })
    })
  }

  private showResult(outcome: DrawOutcome, resolve: () => void) {
    const isJackpot = outcome.win && outcome.drawnCard === 'WHOT20'

    if (outcome.win) {
      isJackpot ? this.sounds.winBig?.play() : this.sounds.win?.play()
      this.playWinFx(isJackpot)
      this.resultBanner
        .setText(isJackpot
          ? `⚡ WHOT 20! +₦${outcome.payout.toLocaleString()}`
          : `You won +₦${outcome.payout.toLocaleString()}`)
        .setColor(isJackpot ? '#FFD700' : '#00E676')
      this.statusText.setText(`It was ${outcome.drawnCard === 'WHOT20' ? 'WHOT 20' : outcome.drawnCard} — ${outcome.multiplier.toFixed(2)}×`)
    } else {
      this.sounds.lose?.play()
      this.playLossFx()
      this.resultBanner.setText(`Drawn: ${outcome.drawnCard === 'WHOT20' ? 'WHOT 20' : outcome.drawnCard}`).setColor('#FF6B6B')
      this.statusText.setText('Not a match — try again')
    }

    this.tweens.add({
      targets: this.resultBanner,
      alpha: 1,
      duration: 200,
    })

    // Reset back to face-down after a pause so the player can read the result.
    // Give losses a touch longer since the crack/dim FX needs to fully fade.
    this.time.delayedCall(outcome.win ? 1700 : 1900, () => this.resetCard())
    resolve()
  }

  // ── WIN FX ───────────────────────────────────────────────────────────────
  // Gold lightning flashes, a pulsing glow ring around the card, an upward
  // coin burst, and camera shake+flash. Jackpot (WHOT20) ramps every knob:
  // more bolts, a bigger coin rain, a full white→gold screen flash.
  private playWinFx(jackpot: boolean) {
    this.flashCardGlow(jackpot ? GOLD : WIN_GREEN)
    this.pulseGlowRing(jackpot)
    this.screenLightningFlash(jackpot ? 5 : 2, jackpot)
    this.spawnCoinBurst(jackpot)

    this.cameras.main.shake(jackpot ? 420 : 220, jackpot ? 0.006 : 0.003)
    if (jackpot) {
      this.cameras.main.flash(180, 255, 255, 255)
      this.time.delayedCall(160, () => this.cameras.main.flash(260, 255, 200, 0))
    } else {
      this.cameras.main.flash(140, 255, 215, 0, false)
    }
  }

  private flashCardGlow(color: number) {
    this.cardFrontGlow.setStrokeStyle(4, color, 1)
    this.tweens.add({
      targets: this.cardFrontGlow,
      alpha: { from: 1, to: 0 },
      duration: 700,
      ease: 'Quad.easeOut',
    })
  }

  // A ring that blooms outward from the card and fades — repeats a couple
  // of extra times for the jackpot so it reads as a bigger celebration.
  private pulseGlowRing(jackpot: boolean) {
    const reps = jackpot ? 3 : 1
    for (let i = 0; i < reps; i++) {
      this.time.delayedCall(i * 220, () => {
        const ring = this.add.circle(this.cardCX, this.cardCY, 90, 0x000000, 0)
          .setStrokeStyle(4, jackpot ? GOLD : WIN_GREEN, 0.9)
        this.tweens.add({
          targets: ring,
          scale: { from: 1, to: 1.9 },
          alpha: { from: 0.9, to: 0 },
          duration: 650,
          ease: 'Quad.easeOut',
          onComplete: () => ring.destroy(),
        })
      })
    }
  }

  // Random jagged bolts streaking across the whole screen, flashing in
  // and fading out — the "lightning storm" beat from the cover art.
  private screenLightningFlash(count: number, jackpot: boolean) {
    const { width, height } = this.scale
    for (let i = 0; i < count; i++) {
      this.time.delayedCall(i * 70, () => {
        const g = this.add.graphics().setDepth(50)
        const fromTop = Phaser.Math.Between(0, 1) === 0
        const x1 = Phaser.Math.Between(0, width)
        const y1 = fromTop ? 0 : height
        const x2 = this.cardCX + Phaser.Math.Between(-60, 60)
        const y2 = this.cardCY + Phaser.Math.Between(-40, 40)
        this.drawLightningPath(g, x1, y1, (x2 - x1) / 20, (y2 - y1) / 20, jackpot ? GOLD : ORANGE, jackpot ? 3.5 : 2.5, 1)
        this.tweens.add({
          targets: g,
          alpha: { from: 1, to: 0 },
          duration: 240,
          ease: 'Quad.easeOut',
          onComplete: () => g.destroy(),
        })
      })
    }
  }

  // Upward coin burst with gravity — bigger, longer, and denser for the
  // WHOT20 jackpot so it reads as a "coin rain" rather than a small pop.
  // NOTE: this.add.particles(x, y, key, config) returns the emitter itself
  // on Phaser 3.60+. If this project is pinned to an older Phaser (<3.60),
  // it returns a ParticleEmitterManager instead — swap to
  // `const manager = this.add.particles(key); const emitter = manager.createEmitter(config)`
  // and destroy the manager instead of the emitter.
  private spawnCoinBurst(jackpot: boolean) {
    const emitter = this.add.particles(this.cardCX, this.cardCY - 40, 'fx-coin', {
      speed: { min: jackpot ? 260 : 150, max: jackpot ? 520 : 320 },
      angle: { min: 250, max: 290 },
      gravityY: 900,
      lifespan: jackpot ? 1600 : 1100,
      scale: { start: 1, end: 0.5 },
      rotate: { start: 0, end: 360 },
      quantity: jackpot ? 4 : 2,
      frequency: jackpot ? 12 : 20,
      duration: jackpot ? 900 : 350,
    })
    emitter.setDepth(40)

    // A quick spark shimmer around the card at the same time
    const sparkEmitter = this.add.particles(this.cardCX, this.cardCY, 'fx-spark', {
      speed: { min: 60, max: 180 },
      angle: { min: 0, max: 360 },
      lifespan: 500,
      scale: { start: 1, end: 0 },
      quantity: jackpot ? 30 : 14,
    })
    sparkEmitter.setDepth(40)
    sparkEmitter.explode(jackpot ? 30 : 14)

    this.time.delayedCall((jackpot ? 900 : 350) + (jackpot ? 1600 : 1100) + 100, () => {
      emitter.destroy()
      sparkEmitter.destroy()
    })
  }

  // ── LOSS FX ─────────────────────────────────────────────────────────────
  // Card dims, thin red cracks fan out from the center and spark briefly,
  // then everything fades before the reset.
  private playLossFx() {
    this.flashCardGlow(LOSE_RED)

    this.tweens.add({
      targets: this.cardFront,
      alpha: { from: 1, to: 0.6 },
      duration: 500,
      yoyo: false,
    })

    const cracks = this.add.graphics().setPosition(this.cardCX, this.cardCY).setDepth(5)
    const cx = 0, cy = 0
    for (let i = 0; i < 4; i++) {
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2)
      const len = Phaser.Math.Between(40, 75)
      this.drawLightningPath(
        cracks,
        cx, cy,
        (Math.cos(angle) * len) / 20, (Math.sin(angle) * len) / 20,
        LOSE_RED, 1.5, 0.9,
      )
    }
    cracks.setAlpha(0)
    this.tweens.add({
      targets: cracks,
      alpha: { from: 0, to: 1 },
      duration: 180,
      yoyo: false,
      onComplete: () => {
        this.tweens.add({
          targets: cracks,
          alpha: 0,
          duration: 700,
          delay: 500,
          onComplete: () => cracks.destroy(),
        })
      },
    })

    const emberEmitter = this.add.particles(this.cardCX, this.cardCY, 'fx-ember', {
      speed: { min: 20, max: 90 },
      angle: { min: 0, max: 360 },
      lifespan: 600,
      gravityY: 200,
      scale: { start: 1, end: 0 },
      quantity: 10,
    })
    emberEmitter.setDepth(5)
    emberEmitter.explode(10)
    this.time.delayedCall(800, () => emberEmitter.destroy())

    this.cameras.main.shake(180, 0.0025)
  }

  private resetCard() {
    this.cardFront.setVisible(false)
    this.cardFront.setAlpha(1)
    this.cardBack.setVisible(true)
    this.cardBack.setScale(1, 1)

    this.tweens.add({
      targets: this.resultBanner,
      alpha: 0,
      duration: 200,
    })
    this.statusText.setText('Pick a card type below')
  }
}

// ── HELPERS ─────────────────────────────────────────────────────────────────
function generateClientSeed(): string {
  // Simple random hex client seed — the provably-fair spec only requires
  // this to be unpredictable to the server ahead of time, not cryptographic.
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')
}