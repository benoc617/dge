/**
 * Game bootstrap — registers all game definitions with the engine registry.
 *
 * Import this module once at the top of any API route that dispatches
 * through the game registry (action, tick, status, register, join, etc.):
 *
 *   import "@/lib/game-bootstrap";
 *
 * Subsequent imports are a no-op (module is evaluated once by Node).
 * This replaces the per-game import lines (`import "@/lib/srx-registration"`)
 * so adding a new game only requires adding one import here.
 */

import "@/lib/srx-registration";
// Future games:
// import "@/lib/chess-registration";
