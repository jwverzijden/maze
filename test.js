const MASK = 0xFFFFFFFFFFFFFFFFn;

function splitmix64(x) {
    x = (x + 0x9e3779b97f4a7c15n) & MASK;
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
}
function mix(...args) {
    let h = 0n;
    for (const a of args) {
        h = splitmix64(h ^ (BigInt(a) & MASK));
    }
    return h;
}
const hash_mod = (h, n) => Number(h % BigInt(n));
const out_of_bounds = (c, L) => !c.every((x) => (x >= 0) && (x < L));
function is_wall(seed, a, b, L, wallchance) {
    if (out_of_bounds(a, L) || out_of_bounds(b, L)) return true;
    return hash_mod(mix(seed, ...a, ...b), 100) < wallchance;
}
const new_array = (n, fill = 0) => new Array(n).fill(fill);

function mix_coords(y, x, sy, sx, p) {
    const newcoord = structuredClone(p);
    newcoord[sy] = y;
    newcoord[sx] = x;
    return newcoord;
}

const is_player_here = (coord, p) => coord.every((c, i) => c === p[i]);

function build_tile_grid(seed, L, sx, sy, p, wallchance) {
    const tiles = new_array(L).map(() => new_array(L));
    for (let y = 0; y < L; y++) {
        const row = tiles[y];
        for (let x = 0; x < L; x++) {
            console.log(y, x, sy, sx, p, mix_coords(y, x, sy, sx, p), is_player_here(mix_coords(y, x, sy, sx, p), p))
            row[x] = {
                y: y,
                x: x,
                player: is_player_here(mix_coords(y, x, sy, sx, p), p),
                left: is_wall(seed, mix_coords(y, x - 1, sy, sx, p), mix_coords(y, x, sy, sx, p), L, wallchance),
                right: is_wall(seed, mix_coords(y, x, sy, sx, p), mix_coords(y, x + 1, sy, sx, p), L, wallchance),
                up: is_wall(seed, mix_coords(y - 1, x, sy, sx, p), mix_coords(y, x, sy, sx, p), L, wallchance),
                down: is_wall(seed, mix_coords(y, x, sy, sx, p), mix_coords(y + 1, x, sy, sx, p), L, wallchance)
            };
        }
    }
    return tiles;
}

function print_tiles(tiles) {
    tiles.forEach(line =>
        line.forEach(item =>
            console.log(
                JSON.stringify(item)
                    .replaceAll('"', '')
                    .replace('{', '')
                    .replace('}', '')
                    .replaceAll(",", "\t")
                    .replaceAll(":", ": ")
                    .replace("left", "walls: left")
                    .replaceAll("false", "    ")
                    .replaceAll("true", "yes ")
            )
        )
    );
}

// test
const seed = 0n; // splitmix64(BigInt(Math.round(Math.random() * 0xFFFFFFFF)));
const L = 3;
const D = 3;
const p = new_array(D);
p[0] = 2;
p[2] = 1;
const wallchance = 50;
const selectedY = 0;
const selectedX = 1;

const visibletiles = build_tile_grid(seed, L, selectedY, selectedX, p, wallchance)

print_tiles(visibletiles);
