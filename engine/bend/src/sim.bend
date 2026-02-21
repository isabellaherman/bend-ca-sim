-- CA-Sim Bend kernel template.
-- Values between __TOKENS__ are injected by engine/bend/src/runner.ts.
--
-- This kernel returns a list of u24 digests (one digest per tick).
-- Runner converts each digest into FrameMessage records.

object Cell {
  typ: u24,
  energy: u24,
  age: u24
}

def mask_u24(x):
  return x & 16777215

def hash_mix(h, v):
  x = h ^ (v & 16777215)
  return (x * 2614507 + 374761) & 16777215

def hash_u24(seed, a, b, c):
  h = seed & 16777215
  h = hash_mix(h, a + 10339193)
  h = hash_mix(h, b + 8776650)
  h = hash_mix(h, c + 12759726)
  return h

def dec_wrap(v, size):
  if v == 0:
    return size - 1
  else:
    return v - 1

def inc_wrap(v, size):
  if v + 1 == size:
    return 0
  else:
    return v + 1

def idx_xy(x, y, width):
  return y * width + x

def cell_type(cells, idx):
  c = cells[idx]
  open Cell: c
  return c.typ

def beats(attacker, defender):
  if attacker == 2:
    return defender == 1
  else:
    if attacker == 1:
      return defender == 3
    else:
      if attacker == 3:
        return defender == 2
      else:
        return 0

def acc_neighbor(n_typ, self_typ, counts):
  (f, w, g, allies, threats, prey) = counts

  if n_typ == 1:
    f = f + 1
  else:
    if n_typ == 2:
      w = w + 1
    else:
      if n_typ == 3:
        g = g + 1

  if self_typ == 0:
    return (f, w, g, allies, threats, prey)

  if n_typ == 0:
    return (f, w, g, allies, threats, prey)

  if n_typ == self_typ:
    allies = allies + 1
    return (f, w, g, allies, threats, prey)

  if beats(n_typ, self_typ):
    threats = threats + 1
    return (f, w, g, allies, threats, prey)

  if beats(self_typ, n_typ):
    prey = prey + 1
    return (f, w, g, allies, threats, prey)

  return (f, w, g, allies, threats, prey)

def neighbor_counts(cells, width, height, idx, self_typ):
  x = idx % width
  y = idx / width

  xl = dec_wrap(x, width)
  xr = inc_wrap(x, width)
  yu = dec_wrap(y, height)
  yd = inc_wrap(y, height)

  nw = idx_xy(xl, yu, width)
  nn = idx_xy(x, yu, width)
  ne = idx_xy(xr, yu, width)
  ww = idx_xy(xl, y, width)
  ee = idx_xy(xr, y, width)
  sw = idx_xy(xl, yd, width)
  ss = idx_xy(x, yd, width)
  se = idx_xy(xr, yd, width)

  counts = (0, 0, 0, 0, 0, 0)
  counts = acc_neighbor(cell_type(cells, nw), self_typ, counts)
  counts = acc_neighbor(cell_type(cells, nn), self_typ, counts)
  counts = acc_neighbor(cell_type(cells, ne), self_typ, counts)
  counts = acc_neighbor(cell_type(cells, ww), self_typ, counts)
  counts = acc_neighbor(cell_type(cells, ee), self_typ, counts)
  counts = acc_neighbor(cell_type(cells, sw), self_typ, counts)
  counts = acc_neighbor(cell_type(cells, ss), self_typ, counts)
  counts = acc_neighbor(cell_type(cells, se), self_typ, counts)
  return counts

def pick_spawn(f, w, g, threshold, seed, tick, idx):
  e1 = f >= threshold
  e2 = w >= threshold
  e3 = g >= threshold

  if e1 == 0:
    if e2 == 0:
      if e3 == 0:
        return 0

  maxc = 0
  if f > maxc:
    maxc = f
  if w > maxc:
    maxc = w
  if g > maxc:
    maxc = g

  leaders = 0
  if e1 == 1:
    if f == maxc:
      leaders = leaders + 1
  if e2 == 1:
    if w == maxc:
      leaders = leaders + 1
  if e3 == 1:
    if g == maxc:
      leaders = leaders + 1

  if leaders == 1:
    if e1 == 1:
      if f == maxc:
        return 1
    if e2 == 1:
      if w == maxc:
        return 2
    if e3 == 1:
      if g == maxc:
        return 3
    return 0

  pick = hash_u24(seed, tick, idx, 17) % leaders

  if e1 == 1:
    if f == maxc:
      if pick == 0:
        return 1
      pick = pick - 1

  if e2 == 1:
    if w == maxc:
      if pick == 0:
        return 2
      pick = pick - 1

  if e3 == 1:
    if g == maxc:
      return 3

  return 0

def compute_next_cell(cells, width, height, idx, seed, tick, repro_threshold, max_energy, spawn_energy, threat_penalty, ally_bonus, prey_bonus, aging_drain):
  cur = cells[idx]
  open Cell: cur
  counts = neighbor_counts(cells, width, height, idx, cur.typ)
  (f, w, g, allies, threats, prey) = counts

  if cur.typ == 0:
    spawn_typ = pick_spawn(f, w, g, repro_threshold, seed, tick, idx)
    if spawn_typ == 0:
      return Cell { typ: 0, energy: 0, age: 0 }
    else:
      e = spawn_energy
      if e > max_energy:
        e = max_energy
      return Cell { typ: spawn_typ, energy: e, age: 0 }

  gain = allies * ally_bonus + prey * prey_bonus
  loss = threats * threat_penalty + aging_drain

  next_energy = cur.energy
  if gain >= loss:
    bonus = gain - loss
    next_energy = cur.energy + bonus
    if next_energy > max_energy:
      next_energy = max_energy
  else:
    drain = loss - gain
    if cur.energy <= drain:
      next_energy = 0
    else:
      next_energy = cur.energy - drain

  if next_energy == 0:
    return Cell { typ: 0, energy: 0, age: 0 }
  else:
    return Cell { typ: cur.typ, energy: next_energy, age: cur.age + 1 }

def range_cells(lo, hi, cells, width, height, seed, tick, repro_threshold, max_energy, spawn_energy, threat_penalty, ally_bonus, prey_bonus, aging_drain):
  if hi <= lo:
    return List/Nil
  else:
    if hi - lo == 1:
      next_cell = compute_next_cell(cells, width, height, lo, seed, tick, repro_threshold, max_energy, spawn_energy, threat_penalty, ally_bonus, prey_bonus, aging_drain)
      return List/Cons { head: next_cell, tail: List/Nil }
    else:
      mid = (lo + hi) / 2
      left = range_cells(lo, mid, cells, width, height, seed, tick, repro_threshold, max_energy, spawn_energy, threat_penalty, ally_bonus, prey_bonus, aging_drain)
      right = range_cells(mid, hi, cells, width, height, seed, tick, repro_threshold, max_energy, spawn_energy, threat_penalty, ally_bonus, prey_bonus, aging_drain)
      return List/concat(left, right)

def list_to_map(xs, idx, out_map):
  match xs:
    case List/Nil:
      return out_map
    case List/Cons:
      out_map[idx] = xs.head
      return list_to_map(xs.tail, idx + 1, out_map)

def digest_cells(xs, h):
  match xs:
    case List/Nil:
      return h
    case List/Cons:
      c = xs.head
      open Cell: c
      h = hash_mix(h, c.typ)
      h = hash_mix(h, c.energy)
      h = hash_mix(h, c.age)
      return digest_cells(xs.tail, h)

def init_cell_type(seed, idx, x, y, init_mode):
  if init_mode == 1:
    cluster_size = 8
    cluster_x = x / cluster_size
    cluster_y = y / cluster_size
    return (hash_u24(seed, cluster_x, cluster_y, 31337) % 3) + 1
  else:
    return (hash_u24(seed, idx, 73, 11) % 3) + 1

def init_alive_chance(seed, idx, x, y, init_mode, alive_ratio_10k):
  if init_mode == 1:
    cluster_size = 8
    cluster_x = x / cluster_size
    cluster_y = y / cluster_size
    cluster_bias = 6000 + (hash_u24(seed, cluster_x, cluster_y, 91) % 8001)
    chance = (alive_ratio_10k * cluster_bias) / 10000
    if chance > 10000:
      return 10000
    else:
      return chance
  else:
    return alive_ratio_10k

def init_cells(idx, size, width, seed, init_mode, alive_ratio_10k, start_energy, out_map):
  if idx == size:
    return out_map

  x = idx % width
  y = idx / width
  typ = init_cell_type(seed, idx, x, y, init_mode)
  alive_chance = init_alive_chance(seed, idx, x, y, init_mode, alive_ratio_10k)
  roll = hash_u24(seed, idx, 19, 7) % 10000

  if roll < alive_chance:
    out_map[idx] = Cell { typ: typ, energy: start_energy, age: 0 }
  else:
    out_map[idx] = Cell { typ: 0, energy: 0, age: 0 }

  return init_cells(idx + 1, size, width, seed, init_mode, alive_ratio_10k, start_energy, out_map)

def run_ticks(tick, max_ticks, width, height, size, seed, repro_threshold, max_energy, spawn_energy, threat_penalty, ally_bonus, prey_bonus, aging_drain, cells, digests):
  if tick == max_ticks:
    return List/reverse(digests)

  next_tick = tick + 1
  next_list = range_cells(0, size, cells, width, height, seed, next_tick, repro_threshold, max_energy, spawn_energy, threat_penalty, ally_bonus, prey_bonus, aging_drain)
  next_cells = list_to_map(next_list, 0, Map/empty())
  digest = digest_cells(next_list, 8461469)
  digests = List/Cons { head: digest, tail: digests }
  return run_ticks(next_tick, max_ticks, width, height, size, seed, repro_threshold, max_energy, spawn_energy, threat_penalty, ally_bonus, prey_bonus, aging_drain, next_cells, digests)

def main:
  width = __WIDTH__
  height = __HEIGHT__
  size = __SIZE__
  ticks = __TICKS__
  seed = __SEED__
  init_mode = __INIT_MODE__
  alive_ratio_10k = __ALIVE_RATIO_10K__
  repro_threshold = __REPRO_THRESHOLD__
  max_energy = __MAX_ENERGY__
  start_energy = __START_ENERGY__
  spawn_energy = __SPAWN_ENERGY__
  threat_penalty = __THREAT_PENALTY__
  ally_bonus = __ALLY_BONUS__
  prey_bonus = __PREY_BONUS__
  aging_drain = __AGING_DRAIN__

  cells = Map/empty()
  cells = init_cells(0, size, width, seed, init_mode, alive_ratio_10k, start_energy, cells)
  return run_ticks(0, ticks, width, height, size, seed, repro_threshold, max_energy, spawn_energy, threat_penalty, ally_bonus, prey_bonus, aging_drain, cells, List/Nil)
