--[[
    Voxel silent aim v2  (place 78884249003161, "Ugc" dump 2026-11-25)
    UI      : WindUI (Footagesus)
    Runtime : Roblox client executor with hookmetamethod, getnamecallmethod, checkcaller

    A __namecall hook catches the game's own FireServer on the weapon remotes and rewrites
    the aim arguments before they leave the client. The camera never moves.

      Infantry
        FireRifle/SMG/LMG/Pistol/DMR/HandCannon (muzzle, dir, t, look, cone)   straight; server rewinds by t
        FireSniper / SV20 FirePistol            (origin, launchDir, t, look, cone) arc re-solved
        FireShotgun                             (muzzle, camOrigin, endPoint...)   pattern rotated onto target
        FireRocket                              (origin, dir, muzzle)              lead + RocketFlight drop
        FireAA + AATrack                        (id, origin, dir, muzzle)          silent lock + auto-fire
        ThrowGrenade / ThrowMolotov / ThrowC4   (origin, velocity[, cook])         throw arc solved to target
      Vehicles
        TankFire      (id, yaw, pitch, weapon, shot)       turret angles solved through def.aim + ShellFlight drop
        HeliFire      (id, "gun", hitPoint, heavy)         clamped to the gun cone like the game does
                      (id, "rocket", aimPoint, pod, podPos)
        HeliDoorFire  (id, [yaw], [true], dir...)          door guns + ground vehicle mounted guns
        EmplacementFire (id, dir...)
        Gunship       ("fire", id, gun, aimPoint)
      Quests
        QuestAction   ("claim", id) / ("track", id)        auto-claim, auto-track, weapon swap, aim bias
]]

local cloneref = cloneref or function(o) return o end
local Players = cloneref(game:GetService("Players"))
local RunService = cloneref(game:GetService("RunService"))
local ReplicatedStorage = cloneref(game:GetService("ReplicatedStorage"))
local UserInputService = cloneref(game:GetService("UserInputService"))
local HttpService = cloneref(game:GetService("HttpService"))
local CoreGui = cloneref(game:GetService("CoreGui"))
local LocalPlayer = Players.LocalPlayer

local genv = (getgenv and getgenv()) or _G
if genv.VoxelSilentAim and genv.VoxelSilentAim.unload then
    pcall(genv.VoxelSilentAim.unload)
end

assert(hookmetamethod and getnamecallmethod and checkcaller,
    "[SilentAim] executor is missing hookmetamethod / getnamecallmethod / checkcaller")
local ncc = newcclosure or function(f) return f end

--------------------------------------------------------------------------------
-- Config
--------------------------------------------------------------------------------
local Config = {
    -- silent aim
    Enabled = false,
    Part = "Torso",            -- "Head" | "Torso"
    FOV = 8,
    HitChance = 100,
    MaxDistance = 1200,
    TeamCheck = true,
    VisibleCheck = true,
    Bots = true,
    Lead = true,
    ShowFOV = true,
    ToggleKey = "G",

    -- infantry weapons
    Bullets = true,
    Snipers = true,
    Shotguns = true,
    Rockets = true,
    RpgVehicles = true,        -- RPG may pick enemy vehicles
    Throwables = true,         -- frag, molotov, C4
    ThrowFOV = 30,

    -- anti-air
    AntiAir = true,
    AAFov = 45,
    AAAutoFire = true,

    -- vehicles
    TankCannon = true,
    HeliGuns = true,           -- nose gun + rocket pods
    MountedGuns = true,        -- door guns, roof guns, emplacements
    Gunship = true,
    VehicleTargets = true,     -- vehicle weapons may pick enemy vehicles
    VehicleFOV = 15,

    -- triggerbot
    Trigger = false,
    TriggerMode = "Hold",      -- "Hold" | "Tap"
    TriggerDelay = 60,         -- ms before the first shot
    TapInterval = 120,         -- ms between taps
    TriggerOnSilent = false,   -- also fire whenever silent aim has a target

    -- no recoil
    NoRecoil = false,
    RecoilScale = 0,           -- % of recoil kept

    -- ESP
    Esp = false,
    EspPlayers = true,
    EspBots = true,
    EspVehicles = true,
    EspChams = true,
    EspDistance = 1500,

    -- auto quest
    AutoClaim = true,
    AutoTrack = true,
    AutoEquip = false,         -- swap to a weapon your open quests need (never mid-fight)
    QuestTargeting = false,    -- bend silent aim toward what the focus quest counts (near/far kills)
    QuestHeads = false,        -- also force Head for headshot quests (feeds the 14-day headshot log)
}

local State = { alive = true, connections = {} }
local QuestBias = nil -- { part, minDist, maxDist } from the auto-quest loop
local function connect(sig, fn)
    local c = sig:Connect(fn)
    table.insert(State.connections, c)
    return c
end

--------------------------------------------------------------------------------
-- Game modules (all optional; every feature that needs one degrades on its own)
--------------------------------------------------------------------------------
local function safeRequire(...)
    local node = ReplicatedStorage
    for _, name in { ... } do
        node = node and node:FindFirstChild(name)
    end
    if not (node and node:IsA("ModuleScript")) then return nil end
    local ok, mod = pcall(require, node)
    return ok and mod or nil
end

local SniperSpecs = safeRequire("Game", "SniperSpecs")
local PistolSpecs = safeRequire("Game", "PistolSpecs")
local Gunsmith = safeRequire("Gunsmith", "Gunsmith")
local RocketFlight = safeRequire("Voxel", "RocketFlight") or {
    EJECT_SPEED = 120, IGNITE = 0.05, ACCEL = 1500, MAX_SPEED = 300, GRAVITY = 9, DROP_DELAY = 0.3,
}
local AirDefense = safeRequire("Vehicles", "AirDefense")
local LoadoutGround = safeRequire("Vehicles", "LoadoutGround")
local LoadoutAir = safeRequire("Vehicles", "LoadoutAir")
local ShellFlight = safeRequire("Vehicles", "ShellFlight")
local GrenadeFlight = safeRequire("Voxel", "GrenadeFlight")
local C4Shared = safeRequire("Voxel", "C4Shared")
local GunRecoil = safeRequire("Voxel", "GunRecoil")

--------------------------------------------------------------------------------
-- Math helpers
--------------------------------------------------------------------------------
local UP = Vector3.yAxis

local function angleBetween(a, b)
    return math.acos(math.clamp(a:Dot(b), -1, 1))
end

local function rotationBetween(a, b)
    local axis = a:Cross(b)
    local dot = math.clamp(a:Dot(b), -1, 1)
    if axis.Magnitude < 1e-6 then
        if dot > 0 then return CFrame.identity end
        local perp = (math.abs(a.X) < 0.9 and Vector3.xAxis or Vector3.yAxis):Cross(a).Unit
        return CFrame.fromAxisAngle(perp, math.pi)
    end
    return CFrame.fromAxisAngle(axis.Unit, math.acos(dot))
end

-- Same clamp the heli client applies before it sends.
local function inCone(dir, axis, cone)
    if angleBetween(dir, axis) <= cone then return dir end
    local cross = axis:Cross(dir)
    if cross.Magnitude < 1e-6 then return axis end
    return CFrame.fromAxisAngle(cross.Unit, cone):VectorToWorldSpace(axis)
end

-- Ballistics mirror (ReplicatedStorage.Voxel.Ballistics)
local function arcFlightTime(dist, speed, arc)
    local k = arc.drag
    return (math.exp(k * dist) - 1) / (k * speed)
end

local function arcDrop(t, speed, arc)
    local k = arc.drag * speed
    return arc.gravity * (t * t / 4 + (k * t - math.log(1 + k * t)) / (2 * k * k))
end

local function arcLaunch(from, to, speed, arc)
    local delta = to - from
    local t = arcFlightTime(delta.Magnitude, speed, arc)
    return (delta + Vector3.new(0, arcDrop(t, speed, arc), 0)).Unit
end

-- Tank shells (ReplicatedStorage.Vehicles.ShellFlight)
local SHELL_GRAVITY = ShellFlight and ShellFlight.GRAVITY or 24.525
local function shellFlightTime(dist, p)
    return (math.exp(p.drag * dist) - 1) / (p.drag * p.speed)
end
local function shellDrop(dist, p)
    local t = shellFlightTime(dist, p)
    local k = p.drag * p.speed
    return SHELL_GRAVITY * (t * t / 4 + (k * t - math.log(1 + k * t)) / (2 * k * k)), t
end

-- RPG (ReplicatedStorage.Voxel.RocketFlight)
local function rocketTimeTo(d)
    local RF = RocketFlight
    local burn = (RF.MAX_SPEED - RF.EJECT_SPEED) / RF.ACCEL
    local d1 = RF.EJECT_SPEED * RF.IGNITE
    local d2 = d1 + RF.EJECT_SPEED * burn + 0.5 * RF.ACCEL * burn * burn
    if d <= d1 then
        return d / RF.EJECT_SPEED
    elseif d <= d2 then
        local c = d1 - d
        return RF.IGNITE + (-RF.EJECT_SPEED + math.sqrt(RF.EJECT_SPEED ^ 2 - 2 * RF.ACCEL * c)) / RF.ACCEL
    end
    return RF.IGNITE + burn + (d - d2) / RF.MAX_SPEED
end

local function rocketDrop(t)
    local RF = RocketFlight
    local after = math.max(t - RF.DROP_DELAY, 0)
    return 0.5 * RF.GRAVITY * after * after
end

-- Arcing rounds. Snipers scale by the Gunsmith velocity mod like SniperFamilyClient does.
local BALLISTIC_FALLBACK = {
    RX10 = { speed = 2300, arc = { gravity = 49, drag = 0.0014 }, gunsmith = true },
    SC11 = { speed = 2300, arc = { gravity = 49, drag = 0.0014 }, gunsmith = true },
    VX50 = { speed = 1300, arc = { gravity = 49, drag = 8e-4 }, gunsmith = true },
    Sniper = { speed = 2150, arc = { gravity = 49, drag = 0.0014 }, gunsmith = true },
    SV20 = { speed = 850, arc = { gravity = 36, drag = 6e-4 } },
}

local ballisticCache = setmetatable({}, { __mode = "k" })
local function ballisticFor(tool)
    if not tool then return nil end
    local cached = ballisticCache[tool]
    if cached ~= nil then return cached or nil end

    local name, entry = tool.Name, nil
    local s = SniperSpecs and SniperSpecs.of and SniperSpecs.of(name)
    if s and s.speed and s.arc then
        entry = { speed = s.speed, arc = s.arc, gunsmith = true }
    end
    if not entry then
        local p = PistolSpecs and PistolSpecs.of and PistolSpecs.of(name)
        if p and p.flight and p.flight.speed and p.flight.arc then
            entry = { speed = p.flight.speed, arc = p.flight.arc }
        end
    end
    entry = entry or BALLISTIC_FALLBACK[name]
    ballisticCache[tool] = entry or false
    return entry
end

local function projectileSpeed(tool, entry)
    if entry.gunsmith and Gunsmith and Gunsmith.velocity then
        local ok, mult = pcall(Gunsmith.velocity, tool)
        if ok and type(mult) == "number" and mult > 0 then
            return entry.speed * mult
        end
    end
    return entry.speed
end

--------------------------------------------------------------------------------
-- World queries
--------------------------------------------------------------------------------
local camPos = Vector3.zero
local THROWABLES = { Grenade = true, Molotov = true, C4 = true }
local NOT_GUNS = {
    Grenade = true, Molotov = true, C4 = true, Smoke = true, Landmine = true, PipeBomb = true,
    Claymore = true, Knife = true, Hammer = true, Shovel = true, BuildHammer = true,
    RepairTorch = true, Flamethrower = true,
}

local function myTeamName()
    local t = LocalPlayer.Team
    if t and not LocalPlayer.Neutral then return t.Name end
    return nil
end

local function currentTool()
    local char = LocalPlayer.Character
    return char and char:FindFirstChildOfClass("Tool")
end

local function vehicleCenter(h)
    local c = h.def and h.def.center
    if typeof(c) == "Vector3" then return h.cf:PointToWorldSpace(c) end
    return h.cf.Position
end

local function vehicleKnown(h)
    return AirDefense ~= nil and (AirDefense.list[h.id] == h or AirDefense.ground[h.id] == h)
end

local function vehicleById(id)
    if not AirDefense then return nil end
    return AirDefense.ground[id] or AirDefense.list[id]
end

local function vehicleEnemy(h, requireRunning)
    if h.wrecked then return false end
    if requireRunning and not h.running then return false end
    local team = h.folder and h.folder:GetAttribute("Team")
    if team == "" or team == nil then return false end
    if Config.TeamCheck and LocalPlayer.Team and team == LocalPlayer.Team.Name then return false end
    return true
end

local function vehicleFlared(h)
    local flare = h.folder and h.folder:GetAttribute("FlareUntil")
    return type(flare) == "number" and workspace:GetServerTimeNow() < flare
end

-- My own ground vehicle, same seat-attribute scan the game's AAFlare client uses.
local myGround, myGroundAt = nil, 0
local function myGroundVehicle(now)
    if now < myGroundAt then return myGround end
    myGroundAt, myGround = now + 0.25, nil
    if not AirDefense then return nil end
    local uid = LocalPlayer.UserId
    for _, v in AirDefense.ground do
        local folder = v.folder
        if folder and not v.wrecked then
            local seats = v.def and v.def.seats
            for i = 1, seats and #seats or 16 do
                if folder:GetAttribute("S" .. i) == uid then
                    myGround = v
                    return v
                end
            end
        end
    end
    return nil
end

local function myVehicle(now)
    return (AirDefense and AirDefense.riding) or myGroundVehicle(now)
end

local function partFor(model, forThrow)
    if forThrow then
        return model:FindFirstChild("HumanoidRootPart") or model.PrimaryPart
    end
    if ((QuestBias and QuestBias.part) or Config.Part) == "Head" then
        local head = model:FindFirstChild("Head")
        if head then return head end
    end
    return model:FindFirstChild("UpperTorso")
        or model:FindFirstChild("Torso")
        or model:FindFirstChild("HumanoidRootPart")
end

-- Every enemy in the match. Same rules as Voxel.HitPredict.enemyOf for people.
local function collectEnemies(out, now)
    table.clear(out)
    local mine = myTeamName()

    for _, plr in Players:GetPlayers() do
        if plr ~= LocalPlayer then
            local char = plr.Character
            if char and char:GetAttribute("Protected") ~= true then
                local hum = char:FindFirstChildOfClass("Humanoid")
                local sameTeam = mine and plr.Team and plr.Team.Name == mine
                if hum and hum.Health > 0 and not (Config.TeamCheck and sameTeam) then
                    out[#out + 1] = { kind = "player", key = char, model = char, player = plr, hum = hum }
                end
            end
        end
    end

    local rigs = workspace:FindFirstChild("BotRigs")
    if rigs then
        for _, m in rigs:GetChildren() do
            if m:IsA("Model")
                and m:GetAttribute("Alive") ~= false
                and m:GetAttribute("Protected") ~= true
                and not (Config.TeamCheck and mine and m:GetAttribute("Team") == mine)
            then
                out[#out + 1] = { kind = "bot", key = m, model = m }
            end
        end
    end

    if AirDefense then
        local own = myVehicle(now)
        for _, list in { AirDefense.list, AirDefense.ground } do
            for _, h in list do
                if h ~= own and h.cf and vehicleEnemy(h, false) then
                    out[#out + 1] = { kind = "vehicle", key = h, h = h }
                end
            end
        end
    end
end

local function entryPosition(e, forThrow)
    if e.kind == "vehicle" then
        return vehicleCenter(e.h), nil
    end
    local part = partFor(e.model, forThrow)
    return part and part.Position, part
end

-- Bot rigs and vehicle sims are CFramed client-side, so velocity is measured, not read.
local track = setmetatable({}, { __mode = "k" })
local function trackVelocity(e, now)
    local pos
    if e.kind == "vehicle" then
        pos = e.h.cf.Position
    else
        local root = e.model:FindFirstChild("HumanoidRootPart") or e.model.PrimaryPart
        if not root then return Vector3.zero end
        pos = root.Position
    end
    local rec = track[e.key]
    if not rec then
        track[e.key] = { pos = pos, t = now, vel = Vector3.zero }
        return Vector3.zero
    end
    local dt = now - rec.t
    if dt > 1 / 240 then
        local raw = (pos - rec.pos) / dt
        if raw.Magnitude > 1500 then raw = Vector3.zero end -- respawn / teleport
        rec.vel = rec.vel:Lerp(raw, math.clamp(dt * 12, 0, 1))
        rec.pos, rec.t = pos, now
    end
    return rec.vel
end

local rayParams = RaycastParams.new()
rayParams.FilterType = Enum.RaycastFilterType.Exclude
rayParams.IgnoreWater = true

local function refreshRayFilter()
    local ignore = { workspace.CurrentCamera }
    if LocalPlayer.Character then ignore[#ignore + 1] = LocalPlayer.Character end
    for _, name in { "VoxelChips", "VoxelLoose", "VoxelGrenades" } do
        local f = workspace:FindFirstChild(name)
        if f then ignore[#ignore + 1] = f end
    end
    rayParams.FilterDescendantsInstances = ignore
end

local function visible(e, point)
    local hit = workspace:Raycast(camPos, point - camPos, rayParams)
    if not hit then return true end
    if e.kind == "vehicle" then
        return (hit.Position - point).Magnitude < 12
    end
    return hit.Instance:IsDescendantOf(e.model)
end

-- Enemy model under a world part (for the triggerbot).
local function enemyModelOf(inst)
    local rigs = workspace:FindFirstChild("BotRigs")
    local model = inst:FindFirstAncestorOfClass("Model")
    while model do
        if (rigs and model.Parent == rigs) or Players:GetPlayerFromCharacter(model) then break end
        model = model:FindFirstAncestorOfClass("Model")
    end
    if not model then return nil end

    local mine = myTeamName()
    if rigs and model.Parent == rigs then
        if model:GetAttribute("Alive") == false or model:GetAttribute("Protected") == true then return nil end
        if mine and model:GetAttribute("Team") == mine then return nil end
        return model
    end

    local plr = Players:GetPlayerFromCharacter(model)
    if not plr or plr == LocalPlayer or model:GetAttribute("Protected") == true then return nil end
    local hum = model:FindFirstChildOfClass("Humanoid")
    if not hum or hum.Health <= 0 then return nil end
    if mine and plr.Team and plr.Team.Name == mine then return nil end
    return model
end

--------------------------------------------------------------------------------
-- Targeting
--------------------------------------------------------------------------------
local enemies = {}
local Current = { entry = nil, part = nil, vel = Vector3.zero, context = "infantry" }

local function contextNow(tool, now)
    if tool then
        if THROWABLES[tool.Name] then return "throw" end
        if tool.Name == "RocketLauncher" then return "rpg" end
        return "infantry"
    end
    if myVehicle(now) then return "vehicle" end
    return "infantry"
end

local function contextFov(ctx)
    if ctx == "throw" then return Config.ThrowFOV end
    if ctx == "vehicle" then return Config.VehicleFOV end
    return Config.FOV
end

local function contextAllows(ctx, e)
    if e.kind == "bot" and not Config.Bots then return false end
    if e.kind ~= "vehicle" then return true end
    if ctx == "rpg" then return Config.RpgVehicles end
    if ctx == "vehicle" then return Config.VehicleTargets end
    return false
end

local function pickTarget(camCF, now, ctx)
    local look = camCF.LookVector
    local forThrow = ctx == "throw"
    local useVis = Config.VisibleCheck and not forThrow -- lobbing over cover is the point
    local bestE, bestPart, bestVel, bestAngle = nil, nil, Vector3.zero, math.rad(contextFov(ctx))
    local quest = ctx == "infantry" and QuestBias or nil
    local minDist = math.max(0.5, quest and quest.minDist or 0)
    local maxDist = math.min(Config.MaxDistance, quest and quest.maxDist or math.huge)

    for _, e in enemies do
        if contextAllows(ctx, e) then
            local vel = trackVelocity(e, now)
            local pos, part = entryPosition(e, forThrow)
            if pos then
                local offset = pos - camPos
                local dist = offset.Magnitude
                if dist > minDist and dist <= maxDist then
                    local angle = angleBetween(offset.Unit, look)
                    if angle < bestAngle and (not useVis or visible(e, pos)) then
                        bestE, bestPart, bestVel, bestAngle = e, part, vel, angle
                    end
                end
            end
        end
    end

    Current.entry, Current.part, Current.vel = bestE, bestPart, bestVel
end

local function livePoint()
    local e = Current.entry
    if not e then return nil end
    if e.kind == "vehicle" then
        if not vehicleKnown(e.h) or e.h.wrecked then return nil end
        return vehicleCenter(e.h), Current.vel
    end
    local part = Current.part
    if part and part.Parent then
        return part.Position, Current.vel
    end
    return nil
end

-- Ground point under the target, for throwables.
local function liveFeet()
    local pos, vel = livePoint()
    if not pos then return nil end
    if Current.entry.kind ~= "vehicle" then
        pos -= Vector3.new(0, 2.5, 0)
    end
    return pos, vel
end

--------------------------------------------------------------------------------
-- Anti-air silent lock
--------------------------------------------------------------------------------
local AA = { h = nil, start = 0, lastSend = 0, ready = false, progress = 0, firedAt = 0 }
local AATrackRemote

local function aaRelease()
    if AA.h and AATrackRemote then
        AATrackRemote:FireServer(0)
    end
    AA.h, AA.ready, AA.progress = nil, false, 0
end

-- Same filter as the AA client's flying(); flared aircraft are skipped (the server rejects them).
local function aaCandidate(h)
    return vehicleEnemy(h, true) and not vehicleFlared(h)
end

local function aaStep(camCF, now, tool)
    local active = Config.Enabled and Config.AntiAir and AirDefense and AATrackRemote
        and tool and tool.Name == (AirDefense.TOOL or "AALauncher")
        and tool:GetAttribute("Loaded") == true

    if not active then
        if AA.h then aaRelease() end
        return
    end

    local range = AirDefense.RANGE or 1800
    local h = AA.h
    if h and not (vehicleKnown(h) and aaCandidate(h) and (vehicleCenter(h) - camPos).Magnitude < range) then
        aaRelease()
        h = nil
    end

    if not h then
        local look, best, bestAngle = camCF.LookVector, nil, math.rad(Config.AAFov)
        for _, list in { AirDefense.list, AirDefense.ground } do
            for _, v in list do
                if v.cf and aaCandidate(v) then
                    local off = vehicleCenter(v) - camPos
                    local angle = angleBetween(off.Unit, look)
                    if off.Magnitude < range and angle < bestAngle then
                        best, bestAngle = v, angle
                    end
                end
            end
        end
        if not best then return end
        AA.h, AA.start, AA.lastSend, AA.ready = best, now, 0, false
        h = best
    end

    if now - AA.lastSend >= (AirDefense.SEND or 0.2) then
        AA.lastSend = now
        AATrackRemote:FireServer(h.id, (vehicleCenter(h) - camPos).Unit)
    end

    local need = (AirDefense.SERVER_LOCK or 2.4) * (h.folder:GetAttribute("AALockScale") or 1) + 0.3
    AA.ready = now - AA.start >= need
    AA.progress = math.clamp((now - AA.start) / need, 0, 1)

    if AA.ready and Config.AAAutoFire and now - AA.firedAt > 1 then
        AA.firedAt = now
        pcall(tool.Activate, tool)
        task.delay(0.15, function() pcall(tool.Deactivate, tool) end)
    end
end

--------------------------------------------------------------------------------
-- Shot rewriting
--------------------------------------------------------------------------------
local BLOCK = {}
local GROUP = {
    FireRifle = "bullet", FireSMG = "bullet", FireLMG = "bullet",
    FirePistol = "bullet", FireDMR = "bullet", FireHandCannon = "bullet",
    FireSniper = "sniper",
    FireShotgun = "shotgun",
    FireRocket = "rocket",
    FireAA = "aa",
    AATrack = "aatrack",
    ThrowGrenade = "grenade",
    ThrowMolotov = "molotov",
    ThrowC4 = "c4",
    TankFire = "tank",
    HeliFire = "heli",
    HeliDoorFire = "dirlist",
    EmplacementFire = "dirlist",
    Gunship = "gunship",
}

local function rollHit()
    return Config.HitChance >= 100 or math.random(1, 100) <= Config.HitChance
end

local function rewriteStraightOrArc(group, args)
    local origin = args[1]
    if typeof(origin) ~= "Vector3" or typeof(args[2]) ~= "Vector3" then return end
    local pos, vel = livePoint()
    if not pos then return end

    local tool = currentTool()
    local entry = (group == "sniper" or (tool and tool.Name == "SV20")) and ballisticFor(tool) or nil
    if entry then
        local speed = projectileSpeed(tool, entry)
        local aim = pos
        if Config.Lead then
            aim = pos + vel * arcFlightTime((pos - origin).Magnitude, speed, entry.arc)
        end
        args[2] = arcLaunch(origin, aim, speed, entry.arc)
    else
        args[2] = (pos - origin).Unit
    end

    if typeof(args[4]) == "Vector3" then
        args[4] = (pos - camPos).Unit
    end
end

-- Rotate every direction/end point around `origin` so their mean lands on the target.
local function rotatePattern(args, first, origin, asPoints, maxAngle)
    local pos = livePoint()
    if not pos then return end

    local sum, count = Vector3.zero, 0
    for i = first, args.n do
        local v = args[i]
        if typeof(v) == "Vector3" then
            local d = asPoints and (v - origin) or v
            if d.Magnitude > 1e-3 then
                sum += d.Unit
                count += 1
            end
        end
    end
    if count == 0 then return end

    local mean = (sum / count).Unit
    local want = pos - origin
    if maxAngle and angleBetween(mean, want.Unit) > maxAngle then return end

    local reach = want.Magnitude + 4
    local rot = rotationBetween(mean, want.Unit)
    for i = first, args.n do
        local v = args[i]
        if typeof(v) == "Vector3" then
            local d = asPoints and (v - origin) or v
            if d.Magnitude > 1e-3 then
                local nd = rot:VectorToWorldSpace(d.Unit)
                args[i] = asPoints and (origin + nd * reach) or nd
            end
        end
    end
end

local function rewriteRocket(args)
    local origin = args[1]
    if typeof(origin) ~= "Vector3" then return end
    local pos, vel = livePoint()
    if not pos then return end

    local aim = pos
    for _ = 1, 4 do
        local t = rocketTimeTo((aim - origin).Magnitude)
        aim = pos + (Config.Lead and vel * t or Vector3.zero) + Vector3.new(0, rocketDrop(t), 0)
    end
    args[2] = (aim - origin).Unit
end

local function rewriteAA(args)
    local h = AA.h
    if not (h and AA.ready) then return end
    local origin = args[2]
    args[1] = h.id
    if typeof(origin) == "Vector3" then
        args[3] = (vehicleCenter(h) - origin).Unit
    end
    AA.h, AA.ready, AA.progress = nil, false, 0 -- lock is spent; the server takes it from here
end

-- Throw arc: scan the launch pitch, keep the lowest arc that lands on the target.
local function solveThrow(origin, target, launchFn, gravityMul)
    local g = workspace.Gravity * gravityMul
    local goal = target
    local bestV, bestT

    for _ = 1, 3 do
        local flat = Vector3.new(goal.X - origin.X, 0, goal.Z - origin.Z)
        local dist = flat.Magnitude
        if dist < 1 then return nil end
        local fwd = flat / dist

        local function evaluate(theta)
            local d = fwd * math.cos(theta) + UP * math.sin(theta)
            local v = launchFn(d)
            local along = v.X * fwd.X + v.Z * fwd.Z
            if along < 0.5 then return nil end
            local t = dist / along
            local y = origin.Y + v.Y * t - 0.5 * g * t * t
            return math.abs(y - target.Y), v, t
        end

        local bestErr, bestTheta = math.huge, nil
        for deg = -40, 85 do
            local err, v, t = evaluate(math.rad(deg))
            if err and err < bestErr - 0.25 then -- prefer the low arc unless the high one is clearly better
                bestErr, bestTheta, bestV, bestT = err, math.rad(deg), v, t
            end
        end
        if not bestTheta then return nil end

        for step = -20, 20 do
            local theta = bestTheta + math.rad(step * 0.05)
            local err, v, t = evaluate(theta)
            if err and err < bestErr then
                bestErr, bestV, bestT = err, v, t
            end
        end
        if bestErr > 6 then return nil end -- out of throwing range

        -- carried sideways velocity pushes the throw off-line; aim the other way
        local side = Vector3.new(bestV.X, 0, bestV.Z) - fwd * (bestV.X * fwd.X + bestV.Z * fwd.Z)
        goal = target - side * bestT
    end
    return bestV, bestT
end

local function myCarry()
    local char = LocalPlayer.Character
    local root = char and char:FindFirstChild("HumanoidRootPart")
    return root and root.AssemblyLinearVelocity or Vector3.zero
end

local function rewriteThrow(group, args)
    local origin, sent = args[1], args[2]
    if typeof(origin) ~= "Vector3" or typeof(sent) ~= "Vector3" then return end
    local pos, vel = liveFeet()
    if not pos then return end

    local carry = myCarry()
    local launchFn, gravityMul

    if group == "c4" then
        if not (C4Shared and C4Shared.launch) then return end
        launchFn = function(d) return C4Shared.launch(d, carry) end
        gravityMul = C4Shared.GRAVITY or 0.9
    else
        if not (GrenadeFlight and GrenadeFlight.launch) then return end
        -- keep whichever throw the player chose (overhand or lob) by matching speeds
        local GF = GrenadeFlight
        local scale = GF.scale and GF.scale() or 1
        local thrown = (sent - carry * (GF.CARRY or 0.6)).Magnitude
        local throwMag = math.sqrt(GF.THROW_SPEED ^ 2 + GF.THROW_LIFT ^ 2) * scale
        local lobMag = math.sqrt(GF.LOB_SPEED ^ 2 + GF.LOB_LIFT ^ 2) * scale
        if thrown < lobMag * 0.5 then return end -- over-cooked: the game drops it at your feet
        local lob = math.abs(thrown - lobMag) < math.abs(thrown - throwMag)
        launchFn = function(d) return GF.launch(d, lob, carry) end
        gravityMul = GF.GRAVITY or 0.6
    end

    local v, t = solveThrow(origin, pos, launchFn, gravityMul)
    if v and Config.Lead and t then
        v = solveThrow(origin, pos + vel * t, launchFn, gravityMul) or v
    end
    if v then args[2] = v end
end

-- Tank: find yaw/pitch so def.aim's barrel points at the target, then send those.
local function solveTurret(v, yaw, pitch, muzzleOf, aimPoint)
    for _ = 1, 8 do
        local turret, barrel = v.def.aim(v.cf, yaw, pitch)
        local muzzle = muzzleOf(turret, barrel)
        local d = barrel:VectorToObjectSpace((aimPoint - muzzle).Unit)
        local dYaw = math.atan2(-d.X, -d.Z)
        local dPitch = math.atan2(d.Y, math.sqrt(d.X * d.X + d.Z * d.Z))
        yaw += dYaw
        pitch += dPitch
        if math.abs(dYaw) + math.abs(dPitch) < 1e-5 then break end
    end
    return yaw, pitch
end

local function rewriteTank(args)
    local id, yaw, pitch, weapon, shot = args[1], args[2], args[3], args[4], args[5]
    if type(yaw) ~= "number" or type(pitch) ~= "number" then return end
    local v = vehicleById(id)
    if not (v and v.def and v.def.aim and v.cf) then return end
    local pos, vel = livePoint()
    if not pos then return end

    local muzzleOf, ballistic
    if weapon == 1 then
        local gun = v.def.gun
        if not gun then return end
        local offset = gun.muzzles and gun.muzzles[(tonumber(shot) or 0) % 2 + 1] or gun.muzzle or Vector3.zero
        muzzleOf = function(_, barrel) return barrel:PointToWorldSpace(offset) end
        if LoadoutGround and LoadoutGround.cannon then
            local ok, p = pcall(LoadoutGround.cannon, v.def, v.folder)
            if ok and type(p) == "table" and p.speed and p.drag then ballistic = p end
        end
    elseif weapon == 2 then
        local launcher = v.def.launcher
        if not launcher or launcher.pods then return end -- pods are the AA lock system
        local mouth = launcher.mouth or Vector3.zero
        muzzleOf = function(turret) return turret:PointToWorldSpace(mouth) end
    else
        return
    end

    local aim = pos
    if ballistic then
        local _, barrel = v.def.aim(v.cf, yaw, pitch)
        local from = muzzleOf(nil, barrel)
        for _ = 1, 3 do
            local drop, t = shellDrop((aim - from).Magnitude, ballistic)
            aim = pos + (Config.Lead and vel * t or Vector3.zero) + Vector3.new(0, drop, 0)
        end
    end

    args[2], args[3] = solveTurret(v, yaw, pitch, muzzleOf, aim)
end

local function rewriteHeli(args)
    local id, kind = args[1], args[2]
    local v = AirDefense and AirDefense.list[id]
    if not (v and v.cf and v.def) then return end
    local pos, vel = livePoint()
    if not pos then return end
    local nose = v.cf.LookVector

    if kind == "gun" and typeof(args[3]) == "Vector3" then
        local muzzles = v.def.GUN_MUZZLES
        local offset = muzzles and muzzles[v.gunSide or 1] or v.def.GUN_MUZZLE or Vector3.zero
        local muzzle = v.cf:PointToWorldSpace(offset)
        local cone = math.rad(10)
        if LoadoutAir and LoadoutAir.gun then
            local ok, g = pcall(LoadoutAir.gun, v.def, v.folder)
            if ok and type(g) == "table" and type(g.cone) == "number" then cone = g.cone end
        end
        local want = pos - muzzle
        if angleBetween(want.Unit, nose) > cone then return end
        args[3] = muzzle + want.Unit * (want.Magnitude + 2)
    elseif kind == "rocket" and typeof(args[5]) == "Vector3" then
        local pod = args[5]
        local cone = math.rad(10)
        if LoadoutAir and LoadoutAir.rockets then
            local ok, r = pcall(LoadoutAir.rockets, v.def, v.folder)
            if ok and type(r) == "table" and type(r.cone) == "number" then cone = r.cone end
        end
        local aim = pos
        if Config.Lead then
            aim = pos + vel * rocketTimeTo((pos - pod).Magnitude)
        end
        local want = aim - pod
        if angleBetween(want.Unit, nose) > cone then return end
        local dir = inCone(want.Unit, nose, cone)
        args[3] = pod + dir * math.max(want.Magnitude, 60)
    end
end

local function rewriteDirList(args)
    -- (id, [yaw number], [true], dir, dir, ...) : directions start at the first Vector3
    local first
    for i = 2, args.n do
        if typeof(args[i]) == "Vector3" then first = i break end
    end
    if not first then return end
    rotatePattern(args, first, camPos, false, math.rad(Config.VehicleFOV))
end

local function rewriteGunship(args)
    if args[1] ~= "fire" or typeof(args[4]) ~= "Vector3" then return end
    local pos = livePoint()
    if pos then args[4] = pos end
end

local function process(group, args)
    if not Config.Enabled then return end

    if group == "aatrack" then
        -- while we hold our own lock, the game's AATrack(0) / partial-lock spam would reset it
        if Config.AntiAir and AA.h then return BLOCK end
        return
    elseif group == "aa" then
        if Config.AntiAir then rewriteAA(args) end
        return
    end

    if not rollHit() then return end

    if group == "bullet" and Config.Bullets then
        rewriteStraightOrArc(group, args)
    elseif group == "sniper" and Config.Snipers then
        rewriteStraightOrArc(group, args)
    elseif group == "shotgun" and Config.Shotguns then
        if typeof(args[2]) == "Vector3" then rotatePattern(args, 3, args[2], true, nil) end
    elseif group == "rocket" and Config.Rockets then
        rewriteRocket(args)
    elseif (group == "grenade" or group == "molotov" or group == "c4") and Config.Throwables then
        rewriteThrow(group, args)
    elseif group == "tank" and Config.TankCannon then
        rewriteTank(args)
    elseif group == "heli" and Config.HeliGuns then
        rewriteHeli(args)
    elseif group == "dirlist" and Config.MountedGuns then
        rewriteDirList(args)
    elseif group == "gunship" and Config.Gunship then
        rewriteGunship(args)
    end
end

local handlers = {}
local function bindRemote(r)
    local group = GROUP[r.Name]
    if group and (r:IsA("RemoteEvent") or r:IsA("UnreliableRemoteEvent")) then
        handlers[r] = group
        if group == "aatrack" then AATrackRemote = r end
    end
end

-- Weapon remotes are spread over Voxel.Remotes, Vehicles.Remotes, Game.Remotes and
-- Game.EmplacementRemotes, so bind by name anywhere under ReplicatedStorage.
ReplicatedStorage:WaitForChild("Voxel"):WaitForChild("Remotes")
for _, r in ReplicatedStorage:GetDescendants() do
    if GROUP[r.Name] and not handlers[r] then bindRemote(r) end
end
connect(ReplicatedStorage.DescendantAdded, function(r)
    if GROUP[r.Name] and not handlers[r] then bindRemote(r) end
end)

local oldNamecall
oldNamecall = hookmetamethod(game, "__namecall", ncc(function(self, ...)
    if State.alive and getnamecallmethod() == "FireServer" and not checkcaller() then
        local group = handlers[self]
        if group then
            local args = table.pack(...)
            local ok, verdict = pcall(process, group, args)
            if ok and verdict == BLOCK then return nil end
            -- call through the property, not oldNamecall: process() may have clobbered the namecall method
            local fire = self.FireServer
            return fire(self, table.unpack(args, 1, args.n))
        end
    end
    return oldNamecall(self, ...)
end))

--------------------------------------------------------------------------------
-- No recoil (wraps the shared GunRecoil class every gun instance uses)
--------------------------------------------------------------------------------
local recoilOriginal = {}
if GunRecoil and type(GunRecoil.shot) == "function" and type(GunRecoil.step) == "function" then
    recoilOriginal.shot, recoilOriginal.step = GunRecoil.shot, GunRecoil.step

    GunRecoil.shot = function(self, ...)
        local r = table.pack(recoilOriginal.shot(self, ...))
        if Config.NoRecoil and State.alive then
            local k = Config.RecoilScale / 100
            self.rawPitch = (self.rawPitch or 0) * k
            self.rawYaw = (self.rawYaw or 0) * k
            self.dipPitch = (self.dipPitch or 0) * k
            self.dipYaw = (self.dipYaw or 0) * k
            self.roll = (self.roll or 0) * k
        end
        return table.unpack(r, 1, r.n)
    end

    GunRecoil.step = function(self, ...)
        local a, b, c = recoilOriginal.step(self, ...)
        if Config.NoRecoil and State.alive then
            local k = Config.RecoilScale / 100
            return (a or 0) * k, (b or 0) * k, (c or 0) * k
        end
        return a, b, c
    end
end

--------------------------------------------------------------------------------
-- HUD: FOV ring, target dot, status, ESP
--------------------------------------------------------------------------------
local hud = Instance.new("ScreenGui")
hud.Name = HttpService:GenerateGUID(false)
hud.IgnoreGuiInset = true
hud.ResetOnSpawn = false
hud.DisplayOrder = 1e6
pcall(function() if syn and syn.protect_gui then syn.protect_gui(hud) end end)
hud.Parent = (gethui and gethui()) or CoreGui

local ring = Instance.new("Frame")
ring.AnchorPoint = Vector2.new(0.5, 0.5)
ring.BackgroundTransparency = 1
ring.Parent = hud
Instance.new("UICorner", ring).CornerRadius = UDim.new(1, 0)
local ringStroke = Instance.new("UIStroke", ring)
ringStroke.Thickness = 1.5
ringStroke.Transparency = 0.35

local dot = Instance.new("Frame")
dot.AnchorPoint = Vector2.new(0.5, 0.5)
dot.Size = UDim2.fromOffset(6, 6)
dot.BackgroundColor3 = Color3.fromRGB(255, 70, 70)
dot.BorderSizePixel = 0
dot.Visible = false
dot.Parent = hud
Instance.new("UICorner", dot).CornerRadius = UDim.new(1, 0)

local status = Instance.new("TextLabel")
status.AnchorPoint = Vector2.new(0.5, 0)
status.BackgroundTransparency = 1
status.Font = Enum.Font.GothamBold
status.TextSize = 14
status.TextColor3 = Color3.fromRGB(255, 196, 70)
status.TextStrokeTransparency = 0.4
status.Size = UDim2.fromOffset(260, 20)
status.Visible = false
status.Parent = hud

local espFolder = Instance.new("Folder")
espFolder.Parent = hud

local ESP_COLORS = {
    player = Color3.fromRGB(255, 80, 80),
    bot = Color3.fromRGB(255, 160, 60),
    vehicle = Color3.fromRGB(255, 220, 70),
    target = Color3.fromRGB(190, 110, 255),
}

local labelPool, labelUsed = {}, 0
local function takeLabel()
    labelUsed += 1
    local l = labelPool[labelUsed]
    if not l then
        l = Instance.new("TextLabel")
        l.AnchorPoint = Vector2.new(0.5, 1)
        l.BackgroundTransparency = 1
        l.Font = Enum.Font.GothamBold
        l.TextSize = 12
        l.TextStrokeTransparency = 0.35
        l.Size = UDim2.fromOffset(200, 30)
        l.TextYAlignment = Enum.TextYAlignment.Bottom
        l.Parent = espFolder
        labelPool[labelUsed] = l
    end
    l.Visible = true
    return l
end

local MAX_CHAMS = 28 -- Roblox renders at most 31 Highlights
local chamPool, chamUsed = {}, 0
local function takeCham()
    if chamUsed >= MAX_CHAMS then return nil end
    chamUsed += 1
    local h = chamPool[chamUsed]
    if not h then
        h = Instance.new("Highlight")
        h.DepthMode = Enum.HighlightDepthMode.AlwaysOnTop
        h.FillTransparency = 0.65
        h.OutlineTransparency = 0.1
        h.Parent = espFolder
        chamPool[chamUsed] = h
    end
    h.Enabled = true
    return h
end

local espSorted = {}
local function drawEsp(cam)
    labelUsed, chamUsed = 0, 0

    if Config.Esp then
        table.clear(espSorted)
        for _, e in enemies do
            local show = (e.kind == "player" and Config.EspPlayers)
                or (e.kind == "bot" and Config.EspBots)
                or (e.kind == "vehicle" and Config.EspVehicles)
            if show then
                local pos = entryPosition(e, true)
                if pos then
                    local dist = (pos - camPos).Magnitude
                    if dist <= Config.EspDistance then
                        espSorted[#espSorted + 1] = { e = e, pos = pos, dist = dist }
                    end
                end
            end
        end
        table.sort(espSorted, function(a, b) return a.dist < b.dist end)

        for _, item in espSorted do
            local e = item.e
            local isTarget = Current.entry and Current.entry.key == e.key
            local color = isTarget and ESP_COLORS.target or ESP_COLORS[e.kind]

            local top = item.pos + Vector3.new(0, e.kind == "vehicle" and 6 or 3, 0)
            local sp, onScreen = cam:WorldToViewportPoint(top)
            if onScreen then
                local name
                if e.kind == "player" then
                    name = e.player.DisplayName
                elseif e.kind == "bot" then
                    name = "[BOT] " .. e.model.Name
                else
                    name = (e.h.def and (e.h.def.name or e.h.def.NAME)) or "Vehicle"
                end
                local hp = ""
                if e.hum and e.hum.MaxHealth > 0 then
                    hp = ("%d HP  "):format(math.floor(e.hum.Health + 0.5))
                end
                local l = takeLabel()
                l.Text = ("%s\n%s%dm"):format(tostring(name), hp, math.floor(item.dist + 0.5))
                l.TextColor3 = color
                l.Position = UDim2.fromOffset(sp.X, sp.Y)
            end

            if Config.EspChams and e.model then
                local h = takeCham()
                if h then
                    h.Adornee = e.model
                    h.FillColor = color
                    h.OutlineColor = color
                end
            end
        end
    end

    for i = labelUsed + 1, #labelPool do labelPool[i].Visible = false end
    for i = chamUsed + 1, #chamPool do
        chamPool[i].Enabled = false
        chamPool[i].Adornee = nil
    end
end

local function drawHud(cam)
    local vp = cam.ViewportSize
    local center = vp * 0.5
    local fov = contextFov(Current.context)

    local showRing = Config.ShowFOV and Config.Enabled and fov < 89
    ring.Visible = showRing
    if showRing then
        local r = math.tan(math.rad(fov)) / math.tan(math.rad(cam.FieldOfView / 2)) * (vp.Y / 2)
        ring.Size = UDim2.fromOffset(r * 2, r * 2)
        ring.Position = UDim2.fromOffset(center.X, center.Y)
        ringStroke.Color = Current.entry and Color3.fromRGB(255, 90, 90) or Color3.fromRGB(255, 255, 255)
    end

    local pos = Config.Enabled and livePoint()
    if pos then
        local sp, onScreen = cam:WorldToViewportPoint(pos)
        dot.Visible = onScreen
        dot.Position = UDim2.fromOffset(sp.X, sp.Y)
    else
        dot.Visible = false
    end

    if AA.h then
        status.Visible = true
        status.Position = UDim2.fromOffset(center.X, center.Y + 60)
        status.Text = AA.ready and "AA SILENT LOCK: READY" or ("AA SILENT LOCK: %d%%"):format(AA.progress * 100)
    else
        status.Visible = false
    end

    drawEsp(cam)
end

--------------------------------------------------------------------------------
-- Triggerbot
--------------------------------------------------------------------------------
local Trig = { since = nil, held = nil, nextTap = 0 }

local function trigRelease()
    if Trig.held then
        local tool = Trig.held
        Trig.held = nil
        if not UserInputService:IsMouseButtonPressed(Enum.UserInputType.MouseButton1) then
            pcall(tool.Deactivate, tool)
        end
    end
end

local function isGun(tool)
    if not tool or NOT_GUNS[tool.Name] then return false end
    if tool.Name == (AirDefense and AirDefense.TOOL or "AALauncher") then return false end -- AA has its own auto-fire
    local handle = tool:FindFirstChild("Handle")
    return handle ~= nil and handle:FindFirstChild("MuzzleAttachment") ~= nil
end

local function triggerStep(camCF, now, tool)
    local want = false
    if Config.Trigger and isGun(tool) then
        local hit = workspace:Raycast(camPos, camCF.LookVector * Config.MaxDistance, rayParams)
        if hit and enemyModelOf(hit.Instance) then
            want = true
        elseif Config.TriggerOnSilent and Config.Enabled and Current.entry and Current.entry.kind ~= "vehicle" then
            want = true
        end
    end

    if not want then
        Trig.since = nil
        trigRelease()
        return
    end

    Trig.since = Trig.since or now
    if now - Trig.since < Config.TriggerDelay / 1000 then return end

    if Config.TriggerMode == "Hold" then
        if Trig.held ~= tool then
            trigRelease()
            pcall(tool.Activate, tool)
            Trig.held = tool
        end
    elseif now >= Trig.nextTap then
        Trig.nextTap = now + Config.TapInterval / 1000
        pcall(tool.Activate, tool)
        task.delay(0.03, function()
            if not UserInputService:IsMouseButtonPressed(Enum.UserInputType.MouseButton1) then
                pcall(tool.Deactivate, tool)
            end
        end)
    end
end

--------------------------------------------------------------------------------
-- Auto quest
--   Progress is counted on the server, so this can't fake kills. It claims rewards the
--   moment QuestClaim lists them, keeps the closest-to-done quests tracked, swaps to a
--   weapon your open quests need, and can steer silent aim toward what they count.
--------------------------------------------------------------------------------
local QuestData = safeRequire("Game", "QuestData")
local STUDS_PER_M = QuestData and QuestData.STUDS_PER_M or 2.5
local TRACK_MAX = QuestData and QuestData.TRACK_MAX or 4

local Quest = { claimAt = {}, actionAt = 0, claimed = 0, summary = "Waiting for quest data...", focus = nil }

local function questRemote()
    local g = ReplicatedStorage:FindFirstChild("Game")
    local r = g and g:FindFirstChild("Remotes")
    return r and r:FindFirstChild("QuestAction")
end

local function attrList(name)
    local s = LocalPlayer:GetAttribute(name)
    if type(s) ~= "string" or s == "" then return {} end
    return string.split(s, ",")
end

-- Weapon groups / tool names a quest counts, or nil if any weapon works.
local function questWants(q)
    local set = {}
    if type(q.tool) == "string" then set[q.tool] = true end
    local only = q.only
    if only and only.group then
        if type(only.group) == "string" then
            set[only.group] = true
        else
            for _, g in only.group do set[g] = true end
        end
    end
    local g = type(q.event) == "string" and q.event:match("^kill_(%a+)$")
    if g then set[g] = true end
    return next(set) and set or nil
end

local function toolFits(tool, set)
    if set[tool.Name] then return true end
    local group = QuestData and QuestData.GROUP and QuestData.GROUP[tool.Name]
    return group ~= nil and set[group] == true
end

local function readQuests()
    if not (QuestData and QuestData.sections) then return nil end
    local ok, sections = pcall(QuestData.sections, LocalPlayer)
    if not ok or type(sections) ~= "table" then return nil end

    local claimable = {}
    for _, id in attrList("QuestClaim") do claimable[id] = true end
    local tracked = {}
    for _, id in attrList("QuestTrack") do tracked[id] = true end
    local level = LocalPlayer:GetAttribute("Level")
    if type(level) ~= "number" then level = 1 end

    local list, weekliesDone = {}, 0
    for _, section in sections do
        for _, q in section.quests or {} do
            local p = LocalPlayer:GetAttribute("Quest_" .. q.id)
            if type(p) ~= "number" then p = q.sample or 0 end
            local done = p >= q.goal
            if section.id == "weekly" and done and q.needs == nil then weekliesDone += 1 end
            list[#list + 1] = {
                q = q,
                section = section.id,
                progress = math.min(p, q.goal),
                ratio = q.goal > 0 and math.min(p, q.goal) / q.goal or 0,
                done = done,
                claimable = claimable[q.id] == true,
                tracked = tracked[q.id] == true,
            }
        end
    end
    for _, it in list do
        local q = it.q
        it.locked = (q.level ~= nil and level < q.level) or (q.needs ~= nil and weekliesDone < q.needs)
        it.open = not it.done and not it.locked
    end
    return list
end

local function openByProgress(list)
    local open = {}
    for _, it in list do
        if it.open then open[#open + 1] = it end
    end
    table.sort(open, function(a, b)
        if a.ratio ~= b.ratio then return a.ratio > b.ratio end
        return a.section == "daily" and b.section ~= "daily"
    end)
    return open
end

local function claimStep(now)
    local remote = questRemote()
    if not remote then return end
    for _, id in attrList("QuestClaim") do
        local last = Quest.claimAt[id]
        if not last or now - last > 8 then -- server didn't pay out yet; retry after 8s
            Quest.claimAt[id] = now
            Quest.claimed += 1
            remote:FireServer("claim", id)
            return -- one per tick so it reads like clicking
        end
    end
end

local function trackStep(open, now)
    if now < Quest.actionAt then return end
    local remote = questRemote()
    if not remote then return end

    local want = {}
    for i = 1, math.min(TRACK_MAX, #open) do want[open[i].q.id] = true end

    local tracked = attrList("QuestTrack")
    for _, id in tracked do
        if not want[id] then
            Quest.actionAt = now + 1.2
            remote:FireServer("track", id) -- "track" toggles, so this untracks
            return
        end
    end
    if #tracked >= TRACK_MAX then return end
    for i = 1, math.min(TRACK_MAX, #open) do
        local it = open[i]
        if not table.find(tracked, it.q.id) then
            Quest.actionAt = now + 1.2
            remote:FireServer("track", it.q.id)
            return
        end
    end
end

local function equipStep(open, now)
    local char = LocalPlayer.Character
    local hum = char and char:FindFirstChildOfClass("Humanoid")
    if not hum or hum.Health <= 0 or myVehicle(now) or Current.entry then return end

    local sets = {}
    for _, it in open do
        local s = questWants(it.q)
        if s then sets[#sets + 1] = s end
    end
    if #sets == 0 then return end

    local held = currentTool()
    if held then
        for _, s in sets do
            if toolFits(held, s) then return end
        end
    end

    local backpack = LocalPlayer:FindFirstChildOfClass("Backpack")
    if not backpack then return end
    for _, s in sets do -- sets are in progress order, so the closest quest wins
        for _, t in backpack:GetChildren() do
            if t:IsA("Tool") and toolFits(t, s) then
                hum:EquipTool(t)
                return
            end
        end
    end
end

local function biasFrom(open)
    for _, it in open do
        local q, only = it.q, it.q.only or {}
        local wantsHead = q.event == "headshots" or only.head or (q.x2 and q.x2.head)
        if only.near or only.far or (wantsHead and Config.QuestHeads) then
            Quest.focus = it
            return {
                part = (wantsHead and Config.QuestHeads) and "Head" or nil,
                minDist = only.far and (only.far * STUDS_PER_M + 2) or nil,
                maxDist = only.near and (only.near * STUDS_PER_M - 1) or nil,
            }
        end
    end
    return nil
end

local function summarize(list, open)
    local counts = { daily = { 0, 0 }, weekly = { 0, 0 } }
    for _, it in list do
        local c = counts[it.section]
        if c then
            c[2] += 1
            if it.done then c[1] += 1 end
        end
    end
    local lines = {
        ("Daily %d/%d   Weekly %d/%d   Claims sent %d"):format(
            counts.daily[1], counts.daily[2], counts.weekly[1], counts.weekly[2], Quest.claimed),
    }
    for i = 1, math.min(4, #open) do
        local it = open[i]
        lines[#lines + 1] = ("%s  %d/%d"):format(it.q.name, it.progress, it.q.goal)
    end
    if QuestBias and Quest.focus then
        lines[#lines + 1] = "Aim bent for: " .. Quest.focus.q.name
    end
    return table.concat(lines, "\n")
end

task.spawn(function()
    while State.alive do
        local now = os.clock()
        if Config.AutoClaim then pcall(claimStep, now) end

        local ok, list = pcall(readQuests)
        if ok and list then
            local open = openByProgress(list)
            Quest.focus = nil
            QuestBias = Config.QuestTargeting and biasFrom(open) or nil
            if Config.AutoTrack then pcall(trackStep, open, now) end
            if Config.AutoEquip then pcall(equipStep, open, now) end
            Quest.summary = summarize(list, open)
        else
            QuestBias = nil
            Quest.summary = QuestData and "Quest data not ready yet"
                or "QuestData didn't load on this executor. Auto-claim still works, tracking/equip/aim bias don't."
        end
        if Quest.panel then
            pcall(function() Quest.panel:SetDesc(Quest.summary) end)
        end
        task.wait(0.5)
    end
end)

--------------------------------------------------------------------------------
-- Frame loop
--------------------------------------------------------------------------------
connect(RunService.RenderStepped, function()
    local cam = workspace.CurrentCamera
    if not cam then return end
    local camCF = cam.CFrame
    camPos = camCF.Position
    local now = os.clock()
    local tool = currentTool()

    refreshRayFilter()
    collectEnemies(enemies, now)
    Current.context = contextNow(tool, now)

    if Config.Enabled then
        pickTarget(camCF, now, Current.context)
    else
        Current.entry, Current.part = nil, nil
        for _, e in enemies do trackVelocity(e, now) end
    end

    aaStep(camCF, now, tool)
    triggerStep(camCF, now, tool)
    drawHud(cam)
end)

--------------------------------------------------------------------------------
-- WindUI
--------------------------------------------------------------------------------
local WindUI = loadstring(game:HttpGet("https://github.com/Footagesus/WindUI/releases/latest/download/main.lua"))()

local Window = WindUI:CreateWindow({
    Title = "Silent Aim",
    Icon = "crosshair",
    Author = "voxel",
    Folder = "VoxelSilentAim",
    Size = UDim2.fromOffset(580, 460),
    Transparent = true,
    Theme = "Dark",
    SideBarWidth = 180,
    HideSearchBar = true,
})
pcall(function() Window:SetToggleKey(Enum.KeyCode.RightShift) end)

local function num(v) return tonumber(type(v) == "table" and v[1] or v) end
local function toggle(tab, title, key, desc, after)
    return tab:Toggle({
        Title = title,
        Desc = desc,
        Default = Config[key], Value = Config[key],
        Callback = function(v)
            Config[key] = v
            if after then after(v) end
        end,
    })
end
local function slider(tab, title, key, min, max, step)
    return tab:Slider({
        Title = title,
        Step = step or 1,
        Value = { Min = min, Max = max, Default = Config[key] },
        Callback = function(v) Config[key] = num(v) or Config[key] end,
    })
end

-- Silent aim
local AimTab = Window:Tab({ Title = "Silent Aim", Icon = "crosshair" })

AimTab:Paragraph({
    Title = "Read this first",
    Desc = "This game scores silent aim on the server: hits far off your camera, plus a 14-day headshot "
        .. "share. Flagged accounts go to cheater-only servers for good. Keep FOV small and use Torso unless you accept that.",
})

local enabledToggle = toggle(AimTab, "Enabled", "Enabled", "Toggle key: " .. Config.ToggleKey)

AimTab:Dropdown({
    Title = "Hit Part",
    Values = { "Head", "Torso" },
    Value = Config.Part,
    Callback = function(v)
        if type(v) == "table" then v = v[1] end
        if v == "Head" or v == "Torso" then Config.Part = v end
    end,
})

slider(AimTab, "FOV (degrees)", "FOV", 1, 180)
slider(AimTab, "Hit Chance (%)", "HitChance", 1, 100)
slider(AimTab, "Max Distance", "MaxDistance", 50, 2000, 25)

AimTab:Section({ Title = "Checks" })
toggle(AimTab, "Team Check", "TeamCheck")
toggle(AimTab, "Visible Check", "VisibleCheck", "Skipped for throwables, lobbing over cover is the point")
toggle(AimTab, "Target Bots", "Bots")
toggle(AimTab, "Lead Moving Targets", "Lead", "Rockets, snipers, SV20, tank shells, throwables")
toggle(AimTab, "Show FOV Circle", "ShowFOV")

-- Weapons
local GunTab = Window:Tab({ Title = "Weapons", Icon = "swords" })

GunTab:Section({ Title = "Infantry" })
toggle(GunTab, "Bullets", "Bullets", "Rifles, SMGs, LMGs, pistols, DMRs, hand cannon")
toggle(GunTab, "Snipers", "Snipers", "Re-solves the bullet arc to the target")
toggle(GunTab, "Shotguns", "Shotguns", "Rotates the whole pellet pattern onto the target")
toggle(GunTab, "Rocket Launcher", "Rockets", "Leads + compensates rocket drop")
toggle(GunTab, "RPG Targets Vehicles", "RpgVehicles", "Aims at enemy tanks and helis by their centre")

GunTab:Section({ Title = "Throwables" })
toggle(GunTab, "Grenade Solver", "Throwables",
    (GrenadeFlight and "Frag, molotov and C4 arcs solved to land on the target"
        or "GrenadeFlight didn't load on this executor, solver unavailable"))
slider(GunTab, "Throwable FOV (degrees)", "ThrowFOV", 5, 180)

GunTab:Section({ Title = "Anti-Air" })
toggle(GunTab, "AA Silent Lock", "AntiAir",
    AirDefense and "Locks the enemy aircraft nearest your crosshair without aiming at it, skips flared ones"
        or "AirDefense didn't load on this executor, AA lock unavailable",
    function(v) if not v then aaRelease() end end)
toggle(GunTab, "AA Auto-Fire", "AAAutoFire", "Fires the moment the silent lock is ready")
slider(GunTab, "AA Lock FOV (degrees)", "AAFov", 5, 180)

-- Vehicles
local CarTab = Window:Tab({ Title = "Vehicles", Icon = "truck" })
CarTab:Paragraph({
    Title = "How it works",
    Desc = "Tank yaw/pitch is re-solved through the vehicle's own aim function. Heli guns stay inside "
        .. "the gun cone like the game clamps them. Door guns and emplacements only redirect within the vehicle FOV.",
})
toggle(CarTab, "Tank Cannon / Missile", "TankCannon", "Shell drop from ShellFlight + lead")
toggle(CarTab, "Heli Gun + Rockets", "HeliGuns")
toggle(CarTab, "Door / Roof / Emplacement Guns", "MountedGuns")
toggle(CarTab, "Gunship", "Gunship")
toggle(CarTab, "Target Enemy Vehicles", "VehicleTargets")
slider(CarTab, "Vehicle FOV (degrees)", "VehicleFOV", 1, 60)

-- Triggerbot
local TrigTab = Window:Tab({ Title = "Triggerbot", Icon = "mouse-pointer-click" })
toggle(TrigTab, "Triggerbot", "Trigger", "Fires when an enemy is under your crosshair",
    function(v) if not v then trigRelease() end end)
TrigTab:Dropdown({
    Title = "Mode",
    Values = { "Hold", "Tap" },
    Value = Config.TriggerMode,
    Callback = function(v)
        if type(v) == "table" then v = v[1] end
        if v == "Hold" or v == "Tap" then
            trigRelease()
            Config.TriggerMode = v
        end
    end,
})
slider(TrigTab, "Reaction Delay (ms)", "TriggerDelay", 0, 400, 5)
slider(TrigTab, "Tap Interval (ms)", "TapInterval", 30, 800, 10)
toggle(TrigTab, "Fire On Silent Target", "TriggerOnSilent",
    "Also fires whenever silent aim has a target. Strong, and much louder to the anti-cheat")

-- Visuals
local VisTab = Window:Tab({ Title = "Visuals", Icon = "eye" })
toggle(VisTab, "ESP", "Esp")
toggle(VisTab, "Players", "EspPlayers")
toggle(VisTab, "Bots", "EspBots")
toggle(VisTab, "Vehicles", "EspVehicles")
toggle(VisTab, "Chams", "EspChams", "Highlight through walls (nearest 28, Roblox caps Highlights)")
slider(VisTab, "ESP Distance", "EspDistance", 100, 3000, 50)

VisTab:Section({ Title = "Recoil" })
toggle(VisTab, "No Recoil", "NoRecoil",
    GunRecoil and "Scales camera kick from every gun" or "GunRecoil didn't load on this executor")
slider(VisTab, "Recoil Kept (%)", "RecoilScale", 0, 100)

-- Quests
local QuestTab = Window:Tab({ Title = "Quests", Icon = "scroll-text" })
Quest.panel = QuestTab:Paragraph({ Title = "Progress", Desc = Quest.summary })
toggle(QuestTab, "Auto Claim", "AutoClaim", "Claims XP + scrap the moment a quest finishes")
toggle(QuestTab, "Auto Track", "AutoTrack", "Keeps the " .. TRACK_MAX .. " closest-to-done quests on your HUD")
toggle(QuestTab, "Auto Equip Quest Weapon", "AutoEquip",
    "Switches to a backpack weapon your open quests count. Never while silent aim has a target")
toggle(QuestTab, "Quest Targeting", "QuestTargeting",
    "Silent aim only picks targets the focus quest counts: under 15m for close kills, past 40/75m for far ones")
toggle(QuestTab, "Headshot Quests Force Head", "QuestHeads",
    "Overrides Hit Part on headshot quests. Feeds their 14-day headshot log, leave off on mains")
QuestTab:Button({
    Title = "Claim Everything Now",
    Callback = function()
        table.clear(Quest.claimAt)
        local remote = questRemote()
        if not remote then return end
        for _, id in attrList("QuestClaim") do
            Quest.claimAt[id] = os.clock()
            Quest.claimed += 1
            remote:FireServer("claim", id)
            task.wait(0.3)
        end
    end,
})

-- Settings
local SetTab = Window:Tab({ Title = "Settings", Icon = "settings" })

SetTab:Keybind({
    Title = "Silent Aim Toggle Key",
    Value = Config.ToggleKey,
    Callback = function(v)
        if typeof(v) == "EnumItem" then v = v.Name end
        if type(v) == "string" and Enum.KeyCode[v] then Config.ToggleKey = v end
    end,
})

SetTab:Keybind({
    Title = "Menu Key",
    Value = "RightShift",
    Callback = function(v)
        if typeof(v) == "EnumItem" then v = v.Name end
        pcall(function() Window:SetToggleKey(Enum.KeyCode[v]) end)
    end,
})

local function unload()
    if not State.alive then return end
    State.alive = false
    Config.Enabled = false
    pcall(aaRelease)
    pcall(trigRelease)
    if recoilOriginal.shot then
        GunRecoil.shot, GunRecoil.step = recoilOriginal.shot, recoilOriginal.step
    end
    for _, c in State.connections do pcall(function() c:Disconnect() end) end
    table.clear(State.connections)
    pcall(function() hud:Destroy() end)
    pcall(function() Window:Destroy() end)
    genv.VoxelSilentAim = nil
end

SetTab:Button({ Title = "Unload", Desc = "Turns everything off and removes the UI", Callback = unload })

connect(UserInputService.InputBegan, function(input, processed)
    if processed or input.UserInputType ~= Enum.UserInputType.Keyboard then return end
    if input.KeyCode.Name == Config.ToggleKey then
        Config.Enabled = not Config.Enabled
        pcall(function() enabledToggle:Set(Config.Enabled) end)
        pcall(function()
            WindUI:Notify({ Title = "Silent Aim", Content = Config.Enabled and "On" or "Off", Duration = 1.5 })
        end)
    end
end)

genv.VoxelSilentAim = { unload = unload, config = Config }

pcall(function()
    WindUI:Notify({
        Title = "Silent Aim loaded",
        Content = ("Press %s to toggle, RightShift for the menu."):format(Config.ToggleKey),
        Duration = 4,
    })
end)
