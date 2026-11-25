--[[
    Voxel silent aim  (place 78884249003161, "Ugc" dump 2026-11-25)
    UI      : WindUI (Footagesus)
    Runtime : Roblox client executor with hookmetamethod, getnamecallmethod, checkcaller

    How it works
      Every gun fires a RemoteEvent in ReplicatedStorage.Voxel.Remotes. A __namecall hook
      catches the game's own FireServer on those remotes and rewrites the aim arguments
      toward the picked target before they leave the client. The camera never moves.

        FireRifle/SMG/LMG/Pistol/DMR/HandCannon (muzzle, dir, t, look, cone)  straight; server rewinds by t
        FireSniper / SV20 FirePistol            (origin, launchDir, t, look, cone)  arc: we re-solve the launch
        FireShotgun                             (muzzle, camOrigin, endPoint...)    whole pattern rotated onto target
        FireRocket                              (origin, dir, muzzle)               lead + RocketFlight drop solved
        FireAA + AATrack                        (id, origin, dir, muzzle)           silent lock: we stream AATrack
                                                                                    at the target for SERVER_LOCK
                                                                                    seconds, then swap the id
]]

local cloneref = cloneref or function(o) return o end
local Players = cloneref(game:GetService("Players"))
local RunService = cloneref(game:GetService("RunService"))
local ReplicatedStorage = cloneref(game:GetService("ReplicatedStorage"))
local UserInputService = cloneref(game:GetService("UserInputService"))
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
    Enabled = false,
    Part = "Torso",          -- "Head" | "Torso"
    FOV = 8,                 -- degrees from crosshair
    HitChance = 100,         -- % of shots redirected
    MaxDistance = 1200,
    TeamCheck = true,
    VisibleCheck = true,
    Bots = true,
    Lead = true,             -- lead moving targets with rockets / arcing rounds
    ShowFOV = true,
    ToggleKey = "G",

    Bullets = true,          -- rifles, SMGs, LMGs, pistols, DMRs, hand cannon
    Snipers = true,
    Shotguns = true,
    Rockets = true,          -- RPG
    AntiAir = true,          -- AA launcher silent lock
    AAFov = 45,
}

local State = { alive = true, connections = {} }
local function connect(sig, fn)
    local c = sig:Connect(fn)
    table.insert(State.connections, c)
    return c
end

--------------------------------------------------------------------------------
-- Game modules (optional; every one has a fallback mirrored from the dump)
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

--------------------------------------------------------------------------------
-- Ballistics (mirror of ReplicatedStorage.Voxel.Ballistics)
--------------------------------------------------------------------------------
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

-- Arcing rounds. Snipers scale by the Gunsmith velocity mod, like SniperFamilyClient does.
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

-- RPG flight (mirror of ReplicatedStorage.Voxel.RocketFlight)
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

--------------------------------------------------------------------------------
-- Targeting
--------------------------------------------------------------------------------
local Current = { model = nil, part = nil, vel = Vector3.zero }
local camPos = Vector3.zero

local function myTeamName()
    local t = LocalPlayer.Team
    if t and not LocalPlayer.Neutral then return t.Name end
    return nil
end

local function currentTool()
    local char = LocalPlayer.Character
    return char and char:FindFirstChildOfClass("Tool")
end

local function partFor(model)
    if Config.Part == "Head" then
        local head = model:FindFirstChild("Head")
        if head then return head end
    end
    return model:FindFirstChild("UpperTorso")
        or model:FindFirstChild("Torso")
        or model:FindFirstChild("HumanoidRootPart")
end

-- Same enemy rules as Voxel.HitPredict.enemyOf
local candidates = {}
local function collectTargets()
    table.clear(candidates)
    local mine = myTeamName()

    for _, plr in Players:GetPlayers() do
        if plr ~= LocalPlayer then
            local char = plr.Character
            if char and char:GetAttribute("Protected") ~= true then
                local hum = char:FindFirstChildOfClass("Humanoid")
                local sameTeam = mine and plr.Team and plr.Team.Name == mine
                if hum and hum.Health > 0 and not (Config.TeamCheck and sameTeam) then
                    candidates[#candidates + 1] = char
                end
            end
        end
    end

    if Config.Bots then
        local rigs = workspace:FindFirstChild("BotRigs")
        if rigs then
            for _, m in rigs:GetChildren() do
                if m:IsA("Model")
                    and m:GetAttribute("Alive") ~= false
                    and m:GetAttribute("Protected") ~= true
                    and not (Config.TeamCheck and mine and m:GetAttribute("Team") == mine)
                then
                    candidates[#candidates + 1] = m
                end
            end
        end
    end
end

-- Bot rigs are CFramed client-side, so velocity comes from position deltas for everyone.
local track = setmetatable({}, { __mode = "k" })
local function trackVelocity(model, now)
    local root = model:FindFirstChild("HumanoidRootPart") or model.PrimaryPart
    if not root then return Vector3.zero end
    local pos = root.Position
    local rec = track[model]
    if not rec then
        track[model] = { pos = pos, t = now, vel = Vector3.zero }
        return Vector3.zero
    end
    local dt = now - rec.t
    if dt > 1 / 240 then
        local raw = (pos - rec.pos) / dt
        if raw.Magnitude > 400 then raw = Vector3.zero end -- respawn / teleport
        rec.vel = rec.vel:Lerp(raw, math.clamp(dt * 12, 0, 1))
        rec.pos, rec.t = pos, now
    end
    return rec.vel
end

local rayParams = RaycastParams.new()
rayParams.FilterType = Enum.RaycastFilterType.Exclude
rayParams.IgnoreWater = true

local function visible(model, point)
    local ignore = { workspace.CurrentCamera }
    if LocalPlayer.Character then ignore[#ignore + 1] = LocalPlayer.Character end
    local chips = workspace:FindFirstChild("VoxelChips")
    if chips then ignore[#ignore + 1] = chips end
    rayParams.FilterDescendantsInstances = ignore

    local hit = workspace:Raycast(camPos, point - camPos, rayParams)
    return hit == nil or hit.Instance:IsDescendantOf(model)
end

local function pickTarget(camCF, now)
    collectTargets()
    local look = camCF.LookVector
    local maxAngle = math.rad(Config.FOV)
    local bestModel, bestPart, bestAngle = nil, nil, maxAngle

    for _, model in candidates do
        local vel = trackVelocity(model, now)
        local part = partFor(model)
        if part then
            local offset = part.Position - camPos
            local dist = offset.Magnitude
            if dist > 0.5 and dist <= Config.MaxDistance then
                local angle = math.acos(math.clamp(offset.Unit:Dot(look), -1, 1))
                if angle < bestAngle and (not Config.VisibleCheck or visible(model, part.Position)) then
                    bestModel, bestPart, bestAngle = model, part, angle
                    Current.vel = vel
                end
            end
        end
    end

    Current.model, Current.part = bestModel, bestPart
    if not bestModel then Current.vel = Vector3.zero end
end

--------------------------------------------------------------------------------
-- Anti-air silent lock
--------------------------------------------------------------------------------
local AA = { h = nil, start = 0, lastSend = 0, ready = false }
local AATrackRemote

local function aaKnown(h)
    return AirDefense and (AirDefense.list[h.id] == h or AirDefense.ground[h.id] == h)
end

local function aaFlying(h)
    if h.wrecked or not h.running then return false end
    local team = h.folder and h.folder:GetAttribute("Team")
    if team == "" or team == nil then return false end
    if LocalPlayer.Team and team == LocalPlayer.Team.Name then return false end
    local flare = h.folder:GetAttribute("FlareUntil")
    return not (type(flare) == "number" and workspace:GetServerTimeNow() < flare)
end

local function aaCenter(h)
    local c = h.def and h.def.center
    if typeof(c) == "Vector3" then return h.cf:PointToWorldSpace(c) end
    return h.cf.Position
end

local function aaRelease()
    if AA.h and AATrackRemote then
        AATrackRemote:FireServer(0)
    end
    AA.h, AA.ready = nil, false
end

local function aaStep(camCF, now)
    local tool = currentTool()
    local active = Config.Enabled and Config.AntiAir and AirDefense and AATrackRemote
        and tool and tool.Name == (AirDefense.TOOL or "AALauncher")
        and tool:GetAttribute("Loaded") == true

    if not active then
        if AA.h then aaRelease() end
        return
    end

    local range = AirDefense.RANGE or 1800
    local h = AA.h
    if h and not (aaKnown(h) and aaFlying(h) and (aaCenter(h) - camPos).Magnitude < range) then
        aaRelease()
        h = nil
    end

    if not h then
        local look, best, bestAngle = camCF.LookVector, nil, math.rad(Config.AAFov)
        for _, list in { AirDefense.list, AirDefense.ground } do
            for _, v in list do
                if aaFlying(v) then
                    local off = aaCenter(v) - camPos
                    local angle = math.acos(math.clamp(off.Unit:Dot(look), -1, 1))
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
        AATrackRemote:FireServer(h.id, (aaCenter(h) - camPos).Unit)
    end

    local need = (AirDefense.SERVER_LOCK or 2.4) * (h.folder:GetAttribute("AALockScale") or 1) + 0.3
    AA.ready = now - AA.start >= need
    AA.progress = math.clamp((now - AA.start) / need, 0, 1)
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
}

local function rollHit()
    return Config.HitChance >= 100 or math.random(1, 100) <= Config.HitChance
end

local function livePoint()
    local part = Current.part
    if part and part.Parent then
        return part.Position, Current.vel
    end
    return nil
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

local function rewriteStraightOrArc(group, args)
    local origin = args[1]
    if typeof(origin) ~= "Vector3" or typeof(args[2]) ~= "Vector3" then return end
    local pos, vel = livePoint()
    if not pos then return end

    local tool = currentTool()
    local entry = (group == "sniper" or tool and tool.Name == "SV20") and ballisticFor(tool) or nil
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

local function rewriteShotgun(args)
    local origin = args[2]
    if typeof(origin) ~= "Vector3" then return end
    local pos = livePoint()
    if not pos then return end

    local sum, count = Vector3.zero, 0
    for i = 3, args.n do
        local p = args[i]
        if typeof(p) == "Vector3" and (p - origin).Magnitude > 1e-3 then
            sum += (p - origin).Unit
            count += 1
        end
    end
    if count == 0 then return end

    local want = pos - origin
    local reach = want.Magnitude + 4
    local rot = rotationBetween((sum / count).Unit, want.Unit)
    for i = 3, args.n do
        local p = args[i]
        if typeof(p) == "Vector3" and (p - origin).Magnitude > 1e-3 then
            args[i] = origin + rot:VectorToWorldSpace((p - origin).Unit) * reach
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
        args[3] = (aaCenter(h) - origin).Unit
    end
    AA.h, AA.ready = nil, false -- lock is spent; the server takes it from here
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
        rewriteShotgun(args)
    elseif group == "rocket" and Config.Rockets then
        rewriteRocket(args)
    end
end

local handlers = {}
local remotes = ReplicatedStorage:WaitForChild("Voxel"):WaitForChild("Remotes")
local function bindRemote(r)
    local group = GROUP[r.Name]
    if group and (r:IsA("RemoteEvent") or r:IsA("UnreliableRemoteEvent")) then
        handlers[r] = group
        if group == "aatrack" then AATrackRemote = r end
    end
end
for _, r in remotes:GetChildren() do bindRemote(r) end
connect(remotes.ChildAdded, bindRemote)

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
-- FOV circle + status
--------------------------------------------------------------------------------
local hud = Instance.new("ScreenGui")
hud.Name = game:GetService("HttpService"):GenerateGUID(false)
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
ringStroke.Color = Color3.fromRGB(255, 255, 255)

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
status.Size = UDim2.fromOffset(240, 20)
status.Visible = false
status.Parent = hud

local function drawHud(cam)
    local vp = cam.ViewportSize
    local center = vp * 0.5

    local showRing = Config.ShowFOV and Config.Enabled and Config.FOV < 89
    ring.Visible = showRing
    if showRing then
        local r = math.tan(math.rad(Config.FOV)) / math.tan(math.rad(cam.FieldOfView / 2)) * (vp.Y / 2)
        ring.Size = UDim2.fromOffset(r * 2, r * 2)
        ring.Position = UDim2.fromOffset(center.X, center.Y)
        ringStroke.Color = Current.part and Color3.fromRGB(255, 90, 90) or Color3.fromRGB(255, 255, 255)
    end

    local part = Current.part
    if Config.Enabled and part and part.Parent then
        local sp, onScreen = cam:WorldToViewportPoint(part.Position)
        dot.Visible = onScreen
        dot.Position = UDim2.fromOffset(sp.X, sp.Y)
    else
        dot.Visible = false
    end

    if AA.h then
        status.Visible = true
        status.Position = UDim2.fromOffset(center.X, center.Y + 60)
        status.Text = AA.ready and "AA SILENT LOCK: READY" or ("AA SILENT LOCK: %d%%"):format((AA.progress or 0) * 100)
    else
        status.Visible = false
    end
end

connect(RunService.RenderStepped, function()
    local cam = workspace.CurrentCamera
    if not cam then return end
    local camCF = cam.CFrame
    camPos = camCF.Position
    local now = os.clock()

    if Config.Enabled then
        pickTarget(camCF, now)
    else
        Current.model, Current.part = nil, nil
    end
    aaStep(camCF, now)
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
    Size = UDim2.fromOffset(560, 440),
    Transparent = true,
    Theme = "Dark",
    SideBarWidth = 180,
    HideSearchBar = true,
})
pcall(function() Window:SetToggleKey(Enum.KeyCode.RightShift) end)

local function num(v) return tonumber(type(v) == "table" and v[1] or v) end

local AimTab = Window:Tab({ Title = "Silent Aim", Icon = "crosshair" })

AimTab:Paragraph({
    Title = "Read this first",
    Desc = "This game scores silent aim on the server: hits far off your camera, plus a 14-day headshot "
        .. "share. Flagged accounts go to cheater-only servers for good. Keep FOV small and use Torso unless you accept that.",
})

local enabledToggle = AimTab:Toggle({
    Title = "Enabled",
    Desc = "Toggle key: " .. Config.ToggleKey,
    Default = Config.Enabled, Value = Config.Enabled,
    Callback = function(v) Config.Enabled = v end,
})

AimTab:Dropdown({
    Title = "Hit Part",
    Values = { "Head", "Torso" },
    Value = Config.Part,
    Callback = function(v)
        if type(v) == "table" then v = v[1] end
        if v == "Head" or v == "Torso" then Config.Part = v end
    end,
})

AimTab:Slider({
    Title = "FOV (degrees)",
    Step = 1,
    Value = { Min = 1, Max = 180, Default = Config.FOV },
    Callback = function(v) Config.FOV = num(v) or Config.FOV end,
})

AimTab:Slider({
    Title = "Hit Chance (%)",
    Step = 1,
    Value = { Min = 1, Max = 100, Default = Config.HitChance },
    Callback = function(v) Config.HitChance = num(v) or Config.HitChance end,
})

AimTab:Slider({
    Title = "Max Distance",
    Step = 25,
    Value = { Min = 50, Max = 2000, Default = Config.MaxDistance },
    Callback = function(v) Config.MaxDistance = num(v) or Config.MaxDistance end,
})

AimTab:Section({ Title = "Checks" })
AimTab:Toggle({ Title = "Team Check", Default = Config.TeamCheck, Value = Config.TeamCheck,
    Callback = function(v) Config.TeamCheck = v end })
AimTab:Toggle({ Title = "Visible Check", Default = Config.VisibleCheck, Value = Config.VisibleCheck,
    Callback = function(v) Config.VisibleCheck = v end })
AimTab:Toggle({ Title = "Target Bots", Default = Config.Bots, Value = Config.Bots,
    Callback = function(v) Config.Bots = v end })
AimTab:Toggle({ Title = "Lead Moving Targets", Desc = "Rockets, snipers, SV20", Default = Config.Lead, Value = Config.Lead,
    Callback = function(v) Config.Lead = v end })
AimTab:Toggle({ Title = "Show FOV Circle", Default = Config.ShowFOV, Value = Config.ShowFOV,
    Callback = function(v) Config.ShowFOV = v end })

local GunTab = Window:Tab({ Title = "Weapons", Icon = "swords" })

GunTab:Toggle({ Title = "Bullets", Desc = "Rifles, SMGs, LMGs, pistols, DMRs, hand cannon",
    Default = Config.Bullets, Value = Config.Bullets, Callback = function(v) Config.Bullets = v end })
GunTab:Toggle({ Title = "Snipers", Desc = "Re-solves the bullet arc to the target",
    Default = Config.Snipers, Value = Config.Snipers, Callback = function(v) Config.Snipers = v end })
GunTab:Toggle({ Title = "Shotguns", Desc = "Rotates the whole pellet pattern onto the target",
    Default = Config.Shotguns, Value = Config.Shotguns, Callback = function(v) Config.Shotguns = v end })
GunTab:Toggle({ Title = "Rocket Launcher", Desc = "Leads + compensates rocket drop",
    Default = Config.Rockets, Value = Config.Rockets, Callback = function(v) Config.Rockets = v end })

GunTab:Section({ Title = "Anti-Air" })
GunTab:Toggle({
    Title = "AA Silent Lock",
    Desc = AirDefense and "Locks the enemy aircraft nearest your crosshair without aiming at it"
        or "AirDefense module didn't load on this executor, so AA lock is unavailable",
    Default = Config.AntiAir, Value = Config.AntiAir,
    Callback = function(v)
        Config.AntiAir = v
        if not v then aaRelease() end
    end,
})
GunTab:Slider({
    Title = "AA Lock FOV (degrees)",
    Step = 1,
    Value = { Min = 5, Max = 180, Default = Config.AAFov },
    Callback = function(v) Config.AAFov = num(v) or Config.AAFov end,
})

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
