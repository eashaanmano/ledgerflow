-- Token bucket, evaluated atomically inside Redis so concurrent gateway replicas cannot
-- both read the same token count and both spend it.
-- KEYS[1] = bucket key
-- ARGV[1] = capacity (burst), ARGV[2] = refill rate in tokens/second, ARGV[3] = cost
-- Returns { allowed (1/0), tokens remaining (floored), retry after in ms }

local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

-- Use Redis' clock, not the caller's, so skew between gateway hosts cannot mint tokens.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate / 1000)

local allowed = 0
local retry_after = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_after = math.ceil((cost - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
-- An idle bucket refills completely after capacity/rate seconds, so it can expire then.
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)

return { allowed, math.floor(tokens), retry_after }
