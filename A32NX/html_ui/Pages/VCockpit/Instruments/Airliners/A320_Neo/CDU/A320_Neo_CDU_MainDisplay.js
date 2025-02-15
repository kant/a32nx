/*
 * A32NX
 * Copyright (C) 2020-2021 FlyByWire Simulations and its contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

class A320_Neo_CDU_MainDisplay extends FMCMainDisplay {
    constructor() {
        super(...arguments);
        this._registered = false;
        this._forceNextAltitudeUpdate = false;
        this._lastUpdateAPTime = NaN;
        this.refreshFlightPlanCooldown = 0;
        this.updateAutopilotCooldown = 0;
        this._lastHasReachFlex = false;
        this._apMasterStatus = false;
        this._hasReachedTopOfDescent = false;
        this._apCooldown = 500;
        this._lastRequestedFLCModeWaypointIndex = -1;
        this.messages = [];
        this.sentMessages = [];
        this.activeSystem = 'FMGC';
        this._cruiseEntered = false;
        this._blockFuelEntered = false;
        this._gpsprimaryack = 0;
        this.currentFlightPhase = FlightPhase.FLIGHT_PHASE_PREFLIGHT;
        this.activeWaypointIdx = -1;
        this.constraintAlt = 0;
        this.constraintAltCached = 0;
        this.fcuSelAlt = 0;
        this.updateTypeIIMessage = false;
        this.altLock = 0;
        this.messageQueue = [];
        this._destDataChecked = false;
        this._towerHeadwind = 0;
        this._conversionWeight = parseFloat(NXDataStore.get("CONFIG_USING_METRIC_UNIT", "1"));
        this._EfobBelowMinClr = false;
        this.simbrief = {
            route: "",
            cruiseAltitude: "",
            originIcao: "",
            destinationIcao: "",
            blockFuel: "",
            payload: undefined,
            estZfw: "",
            sendStatus: "READY",
            costIndex: "",
            navlog: [],
            icao_airline: "",
            flight_number: "",
            alternateIcao: "",
            avgTropopause: "",
            ete: "",
            blockTime: "",
            outTime: "",
            onTime: "",
            inTime: "",
            offTime: "",
            taxiFuel: "",
            tripFuel: ""
        };
        this.aocWeight = {
            blockFuel: undefined,
            estZfw: undefined,
            taxiFuel: undefined,
            tripFuel: undefined,
            payload: undefined
        };
        this.aocTimes = {
            doors: 0,
            off: 0,
            out: 0,
            on: 0,
            in: 0,
        };
        this.winds = {
            climb: [],
            cruise: [],
            des: [],
            alternate: null
        };
    }
    get templateID() {
        return "A320_Neo_CDU";
    }
    connectedCallback() {
        super.connectedCallback();
        RegisterViewListener("JS_LISTENER_KEYEVENT", () => {
            console.log("JS_LISTENER_KEYEVENT registered.");
            RegisterViewListener("JS_LISTENER_FACILITY", () => {
                console.log("JS_LISTENER_FACILITY registered.");
                this._registered = true;
            });
        });
    }
    Init() {
        super.Init();

        this.A32NXCore = new A32NX_Core();
        this.A32NXCore.init(this._lastTime);

        const flightNo = SimVar.GetSimVarValue("ATC FLIGHT NUMBER", "string");
        NXApi.connectTelex(flightNo)
            .catch((err) => {
                if (err !== NXApi.disabledError) {
                    this.addNewMessage(NXFictionalMessages.fltNbrInUse);
                }
            });

        this.onDir = () => {
            CDUDirectToPage.ShowPage(this);
        };
        this.onProg = () => {
            CDUProgressPage.ShowPage(this);
        };
        this.onPerf = () => {
            CDUPerformancePage.ShowPage(this);
        };
        this.onInit = () => {
            CDUInitPage.ShowPage1(this);
        };
        this.onData = () => {
            CDUDataIndexPage.ShowPage1(this);
        };
        this.onFpln = () => {
            CDUFlightPlanPage.ShowPage(this);
        };
        this.onSec = () => {
            CDUSecFplnMain.ShowPage(this);
        };
        this.onRad = () => {
            CDUNavRadioPage.ShowPage(this);
        };
        this.onFuel = () => {
            CDUFuelPredPage.ShowPage(this);
        };
        this.onAtc = () => {
            CDUAtcMenu.ShowPage1(this);
        };
        this.onMenu = () => {
            const cur = this.page.Current;
            setTimeout(() => {
                if (this.page.Current === cur) {
                    CDUMenuPage.ShowPage(this);
                }
            }, this.getDelaySwitchPage());
        };

        CDUMenuPage.ShowPage(this);

        // support spawning in with a custom flight phases from the .flt files
        const initialFlightPhase = SimVar.GetSimVarValue("L:A32NX_INITIAL_FLIGHT_PHASE", "number");
        if (initialFlightPhase) {
            this.currentFlightPhase = initialFlightPhase;
            this.onFlightPhaseChanged();
        }

        this.electricity = this.querySelector("#Electricity");
        this.climbTransitionGroundAltitude = null;
        this.initB = false;

        // If the consent is not set, show telex page
        const onlineFeaturesStatus = NXDataStore.get("CONFIG_ONLINE_FEATURES_STATUS", "UNKNOWN");

        if (onlineFeaturesStatus === "UNKNOWN") {
            CDU_OPTIONS_TELEX.ShowPage(this);
        }

        // Start the TELEX Ping. API functions check the connection status themself
        setInterval(() => {
            const toDelete = [];

            // Update connection
            NXApi.updateTelex()
                .catch((err) => {
                    if (err !== NXApi.disconnectedError && err !== NXApi.disabledError) {
                        console.log("TELEX PING FAILED");
                    }
                });

            // Fetch new messages
            NXApi.getTelexMessages()
                .then((data) => {
                    for (const msg of data) {
                        const sender = msg["from"]["flight"];

                        const lines = [];
                        lines.push("FROM " + sender + "[color]cyan");
                        const incLines = msg["message"].split(";");
                        incLines.forEach(l => lines.push(l.concat("[color]green")));
                        lines.push('---------------------------[color]white');

                        const newMessage = { "id": Date.now(), "type": "FREE TEXT (" + sender + ")", "time": '00:00', "opened": null, "content": lines, };
                        let timeValue = SimVar.GetGlobalVarValue("ZULU TIME", "seconds");
                        if (timeValue) {
                            const seconds = Number.parseInt(timeValue);
                            const displayTime = Utils.SecondsToDisplayTime(seconds, true, true, false);
                            timeValue = displayTime.toString();
                        }
                        newMessage["time"] = timeValue.substring(0, 5);
                        this.messages.unshift(newMessage);
                        toDelete.push(msg["id"]);
                    }

                    const msgCount = SimVar.GetSimVarValue("L:A32NX_COMPANY_MSG_COUNT", "Number");
                    SimVar.SetSimVarValue("L:A32NX_COMPANY_MSG_COUNT", "Number", msgCount + toDelete.length);
                })
                .catch(err => {
                    if (err.status === 404 || err === NXApi.disabledError || err === NXApi.disconnectedError) {
                        return;
                    }
                    console.log("TELEX MSG FETCH FAILED");
                });
        }, NXApi.updateRate);

        // Start the check routine for system health and status
        setInterval(() => {
            if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_CRUISE && !this._destDataChecked) {
                const dest = this.flightPlanManager.getDestination();
                if (dest && dest.liveDistanceTo < 180) {
                    this._destDataChecked = true;
                    this.checkDestData();
                }
            }
        }, 15000);

        SimVar.SetSimVarValue("L:A32NX_GPS_PRIMARY_LOST_MSG", "Bool", 0);
    }

    _formatCell(str) {
        return str
            .replace(/{big}/g, "<span class='b-text'>")
            .replace(/{small}/g, "<span class='s-text'>")
            .replace(/{big}/g, "<span class='b-text'>")
            .replace(/{amber}/g, "<span class='amber'>")
            .replace(/{red}/g, "<span class='red'>")
            .replace(/{green}/g, "<span class='green'>")
            .replace(/{cyan}/g, "<span class='cyan'>")
            .replace(/{white}/g, "<span class='white'>")
            .replace(/{magenta}/g, "<span class='magenta'>")
            .replace(/{yellow}/g, "<span class='yellow'>")
            .replace(/{inop}/g, "<span class='inop'>")
            .replace(/{sp}/g, "&nbsp;")
            .replace(/{end}/g, "</span>");
    }

    setTemplate(_template) {
        super.setTemplate(_template);
        // Apply formatting helper to title page, lines and labels
        if (this._titleElement !== null) {
            this._titleElement.innerHTML = this._formatCell(this._titleElement.innerHTML);
        }
        this._lineElements.forEach((row) => {
            row.forEach((column) => {
                if (column !== null) {
                    column.innerHTML = this._formatCell(column.innerHTML);
                }
            });
        });
        this._labelElements.forEach((row) => {
            row.forEach((column) => {
                if (column !== null) {
                    column.innerHTML = this._formatCell(column.innerHTML);
                }
            });
        });
    }

    checkDestData() {
        if (!isFinite(this.perfApprQNH) || !isFinite(this.perfApprTemp) || !isFinite(this.perfApprWindHeading) || !isFinite(this.perfApprWindSpeed)) {
            this.addNewMessage(NXSystemMessages.enterDestData, () => {
                return isFinite(this.perfApprQNH) && isFinite(this.perfApprTemp) && isFinite(this.perfApprWindHeading) && isFinite(this.perfApprWindSpeed);
            });
        }
    }

    checkEFOBBelowMin() {
        if (!this._minDestFobEntered) {
            this.tryUpdateMinDestFob();
        }
        const EFOBBelMin = this.isAnEngineOn() ? this.getDestEFOB(true) : this.getDestEFOB(false);

        if (EFOBBelMin < this._minDestFob) {
            if (this.isAnEngineOn()) {
                setTimeout(() => {
                    this.addNewMessage(NXSystemMessages.destEfobBelowMin, () => {
                        return this._EfobBelowMinClr === false;
                    }, () => {
                        this._EfobBelowMinClr = true;
                    });
                }, 180000);
            } else {
                this.addNewMessage(NXSystemMessages.destEfobBelowMin, () => {
                    return this._EfobBelowMinClr === false;
                }, () => {
                    this._EfobBelowMinClr = true;
                });
            }
        }
    }

    trySetFlapsTHS(s) {
        if (s) {
            let validEntry = false;
            let nextFlaps = this.flaps;
            let nextThs = this.ths;
            let [flaps, ths] = s.split("/");

            // Parse flaps
            if (flaps && flaps.length > 0) {
                if (!/^\d+$/.test(flaps)) {
                    this.addNewMessage(NXSystemMessages.formatError);
                    return false;
                }

                const vFlaps = parseInt(flaps);
                if (isFinite(vFlaps) && vFlaps > 0 && vFlaps < 4) {
                    nextFlaps = vFlaps;
                    validEntry = true;
                }
            }

            // Parse THS
            if (ths) {
                if (!/^((UP|DN)(\d?\.?\d)|(\d?\.?\d)(UP|DN))$/.test(ths)) {
                    this.addNewMessage(NXSystemMessages.formatError);
                    return false;
                }

                let direction = null;
                ths = ths.replace(/(UP|DN)/g, (substr) => {
                    direction = substr;
                    return "";
                });

                if (direction) {
                    const vThs = parseFloat(ths.trim());
                    if (isFinite(vThs) && vThs >= 0.0 && vThs <= 2.5) {

                        if (vThs === 0.0) {
                            // DN0.0 should be corrected to UP0.0
                            direction = "UP";
                        }

                        nextThs = `${direction}${vThs.toFixed(1)}`;
                        validEntry = true;
                    }
                }
            }

            // Commit changes.
            if (validEntry) {
                this.flaps = nextFlaps;
                this.ths = nextThs;
                return true;
            }
        }

        this.addNewMessage(NXSystemMessages.entryOutOfRange);
        return false;
    }
    onPowerOn() {
        super.onPowerOn();
        if (Simplane.getAutoPilotAirspeedManaged()) {
            this._onModeManagedSpeed();
        } else if (Simplane.getAutoPilotAirspeedSelected()) {
            this._onModeSelectedSpeed();
        }
        this._onModeManagedHeading();
        this._onModeManagedAltitude();

        CDUPerformancePage.UpdateThrRedAccFromOrigin(this);
        CDUPerformancePage.UpdateThrRedAccFromDestination(this);

        SimVar.SetSimVarValue("K:VS_SLOT_INDEX_SET", "number", 1);

        this.taxiFuelWeight = 0.2;
        CDUInitPage.updateTowIfNeeded(this);
    }
    onUpdate(_deltaTime) {
        super.onUpdate(_deltaTime);

        this.checkAocTimes();

        this.A32NXCore.update();

        this.updateMCDU();

        this.updateAutopilot();

        this.updateScreenState();

        this.updateGPSMessage();

        this.updateDisplayedConstraints();

        this._conversionWeight = parseFloat(NXDataStore.get("CONFIG_USING_METRIC_UNIT", "1"));
    }

    /**
     * Checks whether INIT page B is open and an engine is being started, if so:
     * The INIT page B reverts to the FUEL PRED page 15 seconds after the first engine start and cannot be accessed after engine start.
     */
    updateMCDU() {
        if (this.isAnEngineOn()) {
            if (!this.initB) {
                this.initB = true;
                setTimeout(() => {
                    if (this.page.Current === this.page.InitPageB && this.isAnEngineOn()) {
                        CDUFuelPredPage.ShowPage(this);
                    }
                }, 15000);
            }
        } else {
            this.initB = false;
        }
    }

    // check GPS Primary state and display message accordingly
    updateGPSMessage() {
        if (!SimVar.GetSimVarValue("L:GPSPrimaryAcknowledged", "Bool")) {
            if (SimVar.GetSimVarValue("L:GPSPrimary", "Bool")) {
                SimVar.SetSimVarValue("L:A32NX_GPS_PRIMARY_LOST_MSG", "Bool", 0);
                if (!SimVar.GetSimVarValue("L:GPSPrimaryMessageDisplayed", "Bool")) {
                    SimVar.SetSimVarValue("L:GPSPrimaryMessageDisplayed", "Bool", 1);
                    this.tryRemoveMessage(NXSystemMessages.gpsPrimaryLost.text);
                    this.addNewMessage(NXSystemMessages.gpsPrimary, () => {
                        SimVar.SetSimVarValue("L:GPSPrimaryAcknowledged", "Bool", 1);
                    });
                }
            } else {
                SimVar.SetSimVarValue("L:GPSPrimaryMessageDisplayed", "Bool", 0);
                if (!SimVar.GetSimVarValue("L:A32NX_GPS_PRIMARY_LOST_MSG", "Bool")) {
                    SimVar.SetSimVarValue("L:A32NX_GPS_PRIMARY_LOST_MSG", "Bool", 1);
                    this.tryRemoveMessage(NXSystemMessages.gpsPrimary.text);
                    this.addNewMessage(NXSystemMessages.gpsPrimaryLost, () => {
                        SimVar.SetSimVarValue("L:A32NX_GPS_PRIMARY_LOST_MSG", "Bool", 1);
                    });
                }
            }
        }
    }

    updateScreenState() {
        if (SimVar.GetSimVarValue("L:ACPowerAvailable","bool")) {
            this.electricity.style.display = "block";
        } else {
            this.electricity.style.display = "none";
        }
    }

    updateDisplayedConstraints(force = false) {
        const fcuSelAlt = Simplane.getAutoPilotDisplayedAltitudeLockValue("feet");
        if (!force && fcuSelAlt === this.fcuSelAlt) {
            return;
        }
        this.fcuSelAlt = fcuSelAlt;
        this.constraintAlt = A32NX_ConstraintManager.getDisplayedConstraintAltitude(
            this.currentFlightPhase,
            this.fcuSelAlt,
            this.constraintAltCached
        );
    }

    tryUpdateConstraints() {
        const activeWpIdx = this.flightPlanManager.getActiveWaypointIndex();
        if (activeWpIdx === this.activeWpIdx) {
            return;
        }
        this.activeWpIdx = activeWpIdx;
        this.updateConstraints();
    }

    updateConstraints() {
        this.constraintAltCached = A32NX_ConstraintManager.getConstraintAltitude(
            this.currentFlightPhase,
            this.flightPlanManager,
            this.constraintAltCached,
            this._cruiseFlightLevel * 100
        );
        this.updateDisplayedConstraints(true);
    }

    forceClearScratchpad() {
        this.inOut = "";
        this.lastUserInput = "";
        this.isDisplayingErrorMessage = false;
        this.isDisplayingTypeTwoMessage = false;
        this.tryShowMessage();
    }

    /**
     * General message handler
     * @param msg {{text, isAmber, isTypeTwo}} Message Object
     * @param c {function} Function that checks for validity of error message (typeII only)
     * @param f {function} Function gets executed when error message has been cleared (typeII only)
     */
    addNewMessage(msg, c = () => {}, f = () => {
        return false;
    }) {
        if (msg.isTypeTwo) {
            this._addTypeTwoMessage(msg.text, msg.isAmber, c, f);
        } else {
            this._showTypeOneMessage(msg.text, msg.isAmber);
        }
    }

    /**
     * Add Type II Message
     * @param message {string} Message to be displayed
     * @param isAmber {boolean} Is color amber
     * @param c {function} Function that checks for validity of error message
     * @param f {function} Function gets executed when error message has been cleared
     */
    _addTypeTwoMessage(message, isAmber, c, f) {
        if (this.checkForMessage(message)) {
            // Before adding message to queue, check other messages in queue for validity
            for (let i = 0; i < this.messageQueue.length; i++) {
                if (this.messageQueue[i][2](this)) {
                    this.messageQueue.splice(i, 1);
                }
            }
            this.messageQueue.unshift([message, isAmber, c, f]);
            if (this.messageQueue.length > 5) {
                this.messageQueue.splice(5, 1);
            }
            this.tryShowMessage();
        }
    }

    tryShowMessage() {
        if (!this.isDisplayingErrorMessage && (!this.inOut || this.isDisplayingTypeTwoMessage) && this.messageQueue.length > 0) {
            if (this.messageQueue[0][2](this)) {
                this.messageQueue.splice(0, 1);
                this._inOutElement.className = "white";
                this.inOut = this.lastUserInput;
                return this.tryShowMessage();
            }
            if (!this.isDisplayingErrorMessage) {
                if (!this.isDisplayingTypeTwoMessage) {
                    this.isDisplayingTypeTwoMessage = true;
                    this.lastUserInput = this.inOut;
                }
                this.inOut = this.messageQueue[0][0];
                this._inOutElement.className = this.messageQueue[0][1] ? "amber" : "white";
            }
        }
    }

    /**
     * Removes Type II Message
     * @param message {string} Message to be removed
     */
    tryRemoveMessage(message = this.inOut) {
        for (let i = 0; i < this.messageQueue.length; i++) {
            if (this.messageQueue[i][0] === message) {
                this.messageQueue[i][3](this);
                this.messageQueue.splice(i, 1);
                if (i === 0 && this.isDisplayingTypeTwoMessage) {
                    this._inOutElement.className = "white";
                    this.inOut = this.lastUserInput;
                }
                break;
            }
        }
        this.tryShowMessage();
    }

    checkForMessage(message) {
        if (!message) {
            return false;
        }
        for (let i = 0; i < this.messageQueue.length; i++) {
            if (this.messageQueue[i][0] === message) {
                if (i !== 0) {
                    this.messageQueue.unshift(this.messageQueue[i]);
                    this.messageQueue.splice(i + 1, 1);
                    this.tryShowMessage();
                }
                return false;
            }
        }
        return true;
    }

    /**
     * This handler will write data to the scratchpad
     * @param data {string}
     */
    sendDataToScratchpad(data) {
        this.isDisplayingErrorMessage = false;
        this.isDisplayingTypeTwoMessage = false;
        this._inOutElement.className = "white";
        this.inOut = data;
    }

    tryUpdateAltitudeConstraint(force = false) {
        if (this.flightPlanManager.getIsDirectTo()) {
            this.constraintAlt = 0;
        }
        const activeWptIdx = this.flightPlanManager.getActiveWaypointIndex();
        const altLock = Simplane.getAutoPilotSelectedAltitudeLockValue("feet");
        if (force || activeWptIdx !== this.activeWptIdx || altLock !== this.altLock) {
            this.activeWptIdx = activeWptIdx;
            this.altLock = altLock;
            this.constraintAlt = this.getAltitudeConstraint();
        }
    }

    getAltitudeConstraint() {
        const rte = this.flightPlanManager.getWaypoints(0);
        if (rte.length === 0) {
            return 0;
        }
        const fph = Simplane.getCurrentFlightPhase();
        const type = fph < FlightPhase.FLIGHT_PHASE_CRUISE || fph === FlightPhase.FLIGHT_PHASE_GOAROUND ? 3 : 2;
        let tmp = 0;
        for (let i = this.activeWptIdx; i < rte.length; i++) {
            const wpt = rte[i];
            if (!isFinite(wpt.legAltitude1)) {
                continue;
            }
            // Ensure constraint waypoint after TOD is not a constraint for climb phase
            if (tmp) {
                if (type === 3 && (wpt.legAltitude1 < tmp || (isFinite(wpt.legAltitude2) && wpt.legAltitude2 < tmp))) {
                    return 0;
                }
            } else {
                tmp = wpt.legAltitude1;
            }
            if (wpt.legAltitudeDescription === 0) {
                continue;
            }
            if (wpt.legAltitudeDescription === 4) {
                if (type === 3 && this.altLock > wpt.legAltitude2) {
                    return wpt.legAltitude2;
                } else if (type === 2 && this.altLock < wpt.legAltitude1) {
                    return wpt.legAltitude1;
                }
            } else if ((wpt.legAltitudeDescription === 1 || wpt.legAltitudeDescription === type) && (
                (type === 3 && this.altLock > wpt.legAltitude1) || (type === 2 && this.altLock < wpt.legAltitude1)
            )) {
                return wpt.legAltitude1;
            }
        }
        return 0;
    }

    getSpeedConstraint(raw = true) {
        if (this.flightPlanManager.getIsDirectTo()) {
            return Infinity;
        }
        const wpt = this.flightPlanManager.getActiveWaypoint();
        if (typeof wpt === 'undefined' || !isFinite(wpt.speedConstraint) || wpt.speedConstraint < 100) {
            return Infinity;
        }
        if (raw) {
            return wpt.speedConstraint;
        }
        const diff = Simplane.getIndicatedSpeed() - wpt.speedConstraint + 5;
        if (diff < wpt.distanceInFP) {
            return Infinity;
        }
        return wpt.speedConstraint;
    }

    getClbManagedSpeed() {
        let maxSpeed = Infinity;
        if (isFinite(this.v2Speed)) {
            const altitude = Simplane.getAltitude();
            if (altitude < this.thrustReductionAltitude) {
                maxSpeed = this.v2Speed + 50;
            } else {
                maxSpeed = this.getSpeedConstraint();
            }
        }
        let dCI = this.costIndex / 999;
        dCI = dCI * dCI;
        let speed = 290 * (1 - dCI) + 330 * dCI;
        if (SimVar.GetSimVarValue("PLANE ALTITUDE", "feet") < 10000) {
            speed = Math.min(speed, 250);
        }
        return Math.min(maxSpeed, speed);
    }
    getFlapTakeOffSpeed() {
        const dWeight = (this.getWeight() - 47) / (78 - 47);
        return 119 + 34 * dWeight;
    }
    getSlatTakeOffSpeed() {
        const dWeight = (this.getWeight() - 47) / (78 - 47);
        return 154 + 44 * dWeight;
    }

    /**
     * Get aircraft takeoff and approach green dot speed
     * Calculation:
     * Gross weight in thousandths (KG) * 2 + 85 when below FL200
     * @returns {number}
     */
    getPerfGreenDotSpeed() {
        return ((this.getGrossWeight("kg") / 1000) * 2) + 85;
    }

    /**
     * Get the gross weight of the aircraft from the addition
     * of the ZFW, fuel and payload.
     * @param unit
     * @returns {number}
     */
    getGrossWeight(unit) {
        const fuelWeight = SimVar.GetSimVarValue("FUEL TOTAL QUANTITY WEIGHT", unit);
        const emptyWeight = SimVar.GetSimVarValue("EMPTY WEIGHT", unit);
        const payloadWeight = this.getPayloadWeight(unit);
        return Math.round(emptyWeight + fuelWeight + payloadWeight);
    }

    /**
     * Get the payload of the aircraft, taking in to account each
     * payload station
     * @param unit
     * @returns {number}
     */
    getPayloadWeight(unit) {
        const payloadCount = SimVar.GetSimVarValue("PAYLOAD STATION COUNT", "number");
        let payloadWeight = 0;
        for (let i = 1; i <= payloadCount; i++) {
            payloadWeight += SimVar.GetSimVarValue(`PAYLOAD STATION WEIGHT:${i}`, unit);
        }
        return payloadWeight;
    }

    updateTowerHeadwind() {
        if (isFinite(this.perfApprWindSpeed) && isFinite(this.perfApprWindHeading)) {
            const rwy = this.flightPlanManager.getApproachRunway();
            if (rwy) {
                this._towerHeadwind = NXSpeedsUtils.getHeadwind(this.perfApprWindSpeed, this.perfApprWindHeading, rwy.direction);
            }
        }
    }

    _onModeSelectedSpeed() {
        if (SimVar.GetSimVarValue("L:A320_FCU_SHOW_SELECTED_SPEED", "number") === 0) {
            const currentSpeed = Simplane.getIndicatedSpeed();
            this.setAPSelectedSpeed(currentSpeed, Aircraft.A320_NEO);
        }
        SimVar.SetSimVarValue("K:SPEED_SLOT_INDEX_SET", "number", 1);
    }
    _onModeManagedSpeed() {
        SimVar.SetSimVarValue("K:SPEED_SLOT_INDEX_SET", "number", 2);
        SimVar.SetSimVarValue("L:A320_FCU_SHOW_SELECTED_SPEED", "number", 0);
    }
    _onModeSelectedHeading() {
        if (SimVar.GetSimVarValue("AUTOPILOT APPROACH HOLD", "boolean")) {
            return;
        }
        if (!SimVar.GetSimVarValue("AUTOPILOT HEADING LOCK", "Boolean")) {
            SimVar.SetSimVarValue("K:AP_PANEL_HEADING_HOLD", "Number", 1);
        }
        SimVar.SetSimVarValue("K:HEADING_SLOT_INDEX_SET", "number", 1);
        SimVar.SetSimVarValue("L:A32NX_GOAROUND_HDG_MODE", "bool", 1);
    }
    _onModeManagedHeading() {
        if (SimVar.GetSimVarValue("AUTOPILOT APPROACH HOLD", "boolean")) {
            return;
        }
        if (!SimVar.GetSimVarValue("AUTOPILOT HEADING LOCK", "Boolean")) {
            SimVar.SetSimVarValue("K:AP_PANEL_HEADING_HOLD", "Number", 1);
        }
        SimVar.SetSimVarValue("K:HEADING_SLOT_INDEX_SET", "number", 2);
        SimVar.SetSimVarValue("L:A320_FCU_SHOW_SELECTED_HEADING", "number", 0);
    }
    _onModeSelectedAltitude() {
        if (!Simplane.getAutoPilotGlideslopeHold()) {
            SimVar.SetSimVarValue("L:A320_NEO_FCU_FORCE_IDLE_VS", "Number", 1);
        }
        SimVar.SetSimVarValue("K:ALTITUDE_SLOT_INDEX_SET", "number", 1);
        Coherent.call("AP_ALT_VAR_SET_ENGLISH", 1, Simplane.getAutoPilotDisplayedAltitudeLockValue(), this._forceNextAltitudeUpdate);
    }
    _onModeManagedAltitude() {
        SimVar.SetSimVarValue("K:ALTITUDE_SLOT_INDEX_SET", "number", 2);
        Coherent.call("AP_ALT_VAR_SET_ENGLISH", 1, Simplane.getAutoPilotDisplayedAltitudeLockValue(), this._forceNextAltitudeUpdate);
        Coherent.call("AP_ALT_VAR_SET_ENGLISH", 2, Simplane.getAutoPilotDisplayedAltitudeLockValue(), this._forceNextAltitudeUpdate);
        if (!Simplane.getAutoPilotGlideslopeHold()) {
            this.requestCall(() => {
                SimVar.SetSimVarValue("L:A320_NEO_FCU_FORCE_IDLE_VS", "Number", 1);
            });
        }
    }
    onEvent(_event) {
        super.onEvent(_event);
        // console.log("A320_Neo_CDU_MainDisplay onEvent " + _event);
        if (_event === "MODE_SELECTED_SPEED") {
            this._onModeSelectedSpeed();
        }
        if (_event === "MODE_MANAGED_SPEED") {
            if (this.flightPlanManager.getWaypointsCount() === 0) {
                return;
            }
            this._onModeManagedSpeed();
        }
        if (_event === "MODE_SELECTED_HEADING") {
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_HDG_MODE", "bool", 1);
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_NAV_MODE", "bool", 0);
            //why is below code checking for waypointcounts when we are in selected mode?
            //if (this.flightPlanManager.getWaypointsCount() === 0) {
            //    return;
            //}
            if (Simplane.getAutoPilotHeadingManaged()) {
                if (SimVar.GetSimVarValue("L:A320_FCU_SHOW_SELECTED_HEADING", "number") === 0) {
                    const currentHeading = Simplane.getHeadingMagnetic();
                    Coherent.call("HEADING_BUG_SET", 1, currentHeading);
                }
            }
            this._onModeSelectedHeading();
        }
        if (_event === "MODE_MANAGED_HEADING") {
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_HDG_MODE", "bool", 0);
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_NAV_MODE", "bool", 1);
            if (this.flightPlanManager.getWaypointsCount() === 0) {
                return;
            }
            this._onModeManagedHeading();
        }
        if (_event === "MODE_SELECTED_ALTITUDE") {
            this._onModeSelectedAltitude();
        }
        if (_event === "MODE_MANAGED_ALTITUDE") {
            this._onModeManagedAltitude();
        }
        if (_event === "AP_DEC_SPEED" || _event === "AP_INC_SPEED") {
            if (SimVar.GetSimVarValue("L:A320_FCU_SHOW_SELECTED_SPEED", "number") === 0) {
                const currentSpeed = Simplane.getIndicatedSpeed();
                this.setAPSelectedSpeed(currentSpeed, Aircraft.A320_NEO);
            }
            SimVar.SetSimVarValue("L:A320_FCU_SHOW_SELECTED_SPEED", "number", 1);
        }
        if (_event === "AP_DEC_HEADING" || _event === "AP_INC_HEADING") {
            if (SimVar.GetSimVarValue("L:A320_FCU_SHOW_SELECTED_HEADING", "number") === 0) {
                const currentHeading = Simplane.getHeadingMagnetic();
                Coherent.call("HEADING_BUG_SET", 1, currentHeading);
            }
            SimVar.SetSimVarValue("L:A320_FCU_SHOW_SELECTED_HEADING", "number", 1);
        }
    }
    onFlightPhaseChanged() {
        this.updateConstraints();
        if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_TAKEOFF) {
            this._destDataChecked = false;
        } else if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_CLIMB) {
            this._destDataChecked = false;
            let preSelectedClbSpeed = this.preSelectedClbSpeed;
            if (SimVar.GetSimVarValue("L:A32NX_GOAROUND_PASSED", "bool") === 1) {
                preSelectedClbSpeed = this.getPerfGreenDotSpeed();
            }
            if (isFinite(preSelectedClbSpeed)) {
                this.setAPSelectedSpeed(preSelectedClbSpeed, Aircraft.A320_NEO);
                SimVar.SetSimVarValue("K:SPEED_SLOT_INDEX_SET", "number", 1);
            }
            SimVar.SetSimVarValue("L:A32NX_AUTOBRAKES_BRAKING", "Bool", 0);
        } else if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_CRUISE) {
            if (isFinite(this.preSelectedCrzSpeed)) {
                this.setAPSelectedSpeed(this.preSelectedCrzSpeed, Aircraft.A320_NEO);
                SimVar.SetSimVarValue("K:SPEED_SLOT_INDEX_SET", "number", 1);
            }
        } else if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_DESCENT) {
            this.checkDestData();
            if (isFinite(this.preSelectedDesSpeed)) {
                this.setAPSelectedSpeed(this.preSelectedDesSpeed, Aircraft.A320_NEO);
                SimVar.SetSimVarValue("K:SPEED_SLOT_INDEX_SET", "number", 1);
            }
        } else if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_APPROACH) {
            this.checkDestData();
        }
        //TODO something for Goaround? Like Green Dot Speed SRS etc ...
    }
    onInputAircraftSpecific(input) {
        if (input === "DIR") {
            if (this.onDir) {
                this.onDir();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "PROG") {
            if (this.onProg) {
                this.onProg();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "PERF") {
            if (this.onPerf) {
                this.onPerf();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "INIT") {
            if (this.onInit) {
                this.onInit();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "DATA") {
            if (this.onData) {
                this.onData();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "FPLN") {
            if (this.onFpln) {
                this.onFpln();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "RAD") {
            if (this.onRad) {
                this.onRad();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "FUEL") {
            if (this.onFuel) {
                this.onFuel();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "SEC") {
            if (this.onSec) {
                this.onSec();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "ATC") {
            if (this.onAtc) {
                this.onAtc();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "MENU") {
            if (this.onMenu) {
                this.onMenu();
                // } else if (input === "MCDU") {
                //     if (this.onMcdu) {
                //         this.onMcdu();
            }
            return true;
        } else if (input === "AIRPORT") {
            if (this.onAirport) {
                this.onAirport();
                this.activeSystem = 'FMGC';
            }
            return true;
        } else if (input === "UP") {
            if (this.onUp) {
                this.onUp();
            }
            return true;
        } else if (input === "DOWN") {
            if (this.onDown) {
                this.onDown();
            }
            return true;
        } else if (input === "LEFT") {
            if (this.onLeft) {
                this.onLeft();
            }
            return true;
        } else if (input === "RIGHT") {
            if (this.onRight) {
                this.onRight();
            }
        } else if (input === "OVFY") {
            if (this.onOvfy) {
                this.onOvfy();
            }
            return true;
        }
        return false;
    }
    clearDisplay() {
        super.clearDisplay();
        this.onUp = undefined;
        this.onDown = undefined;
        this.onLeft = undefined;
        this.onRight = undefined;
    }
    getOrSelectWaypointByIdent(ident, callback) {
        this.dataManager.GetWaypointsByIdent(ident).then((waypoints) => {
            if (!waypoints || waypoints.length === 0) {
                return callback(undefined);
            }
            if (waypoints.length === 1) {
                return callback(waypoints[0]);
            }
            A320_Neo_CDU_SelectWptPage.ShowPage(this, waypoints, callback);
        });
    }

    _getTempIndex() {
        const temp = SimVar.GetSimVarValue("AMBIENT TEMPERATURE", "celsius");
        if (temp < -10) {
            return 0;
        }
        if (temp < 0) {
            return 1;
        }
        if (temp < 10) {
            return 2;
        }
        if (temp < 20) {
            return 3;
        }
        if (temp < 30) {
            return 4;
        }
        if (temp < 40) {
            return 5;
        }
        if (temp < 43) {
            return 6;
        }
        if (temp < 45) {
            return 7;
        }
        if (temp < 47) {
            return 8;
        }
        if (temp < 49) {
            return 9;
        }
        if (temp < 51) {
            return 10;
        }
        if (temp < 53) {
            return 11;
        }
        if (temp < 55) {
            return 12;
        }
        if (temp < 57) {
            return 13;
        }
        if (temp < 59) {
            return 14;
        }
        if (temp < 61) {
            return 15;
        }
        if (temp < 63) {
            return 16;
        }
        if (temp < 65) {
            return 17;
        }
        if (temp < 66) {
            return 18;
        }
        return 19;
    }

    _getVSpeed(dWeightCoef, min, max) {
        let runwayCoef = 1.0;
        const runway = this.flightPlanManager.getDepartureRunway() || this.flightPlanManager.getDetectedCurrentRunway();
        if (runway) {
            const f = (runway.length - 1500) / (2500 - 1500);
            runwayCoef = Utils.Clamp(f, 0, 1);
        }

        const flapsHandleIndex = this.flaps || Simplane.getFlapsHandleIndex();

        let vSpeed = min * (1 - runwayCoef) + max * runwayCoef;
        vSpeed *= dWeightCoef;
        vSpeed += (3 - flapsHandleIndex) * 6;
        return Math.round(vSpeed);
    }

    _getV1Speed() {
        /*let dWeightCoef = (this.getWeight(true) - 100) / (175 - 100);
        dWeightCoef = Utils.Clamp(dWeightCoef, 0, 1);
        dWeightCoef = 0.7 + (1.0 - 0.7) * dWeightCoef;

        const tempIndex = this._getTempIndex();
        const min = A320_Neo_CDU_MainDisplay._v1sConf1[tempIndex][0];
        const max = A320_Neo_CDU_MainDisplay._v1sConf1[tempIndex][1];

        return this._getVSpeed(dWeightCoef, min, max);*/
        return (new NXToSpeeds(SimVar.GetSimVarValue("TOTAL WEIGHT", "kg") / 1000, this.flaps, Simplane.getAltitude())).v1;
    }
    _computeV1Speed() {
        // computeV1Speed is called by inherited class so it must remain,
        // but we need the calculation logic so that sits in it's own function now.
        const nextV1 = this._getV1Speed();
        this.v1Speed = nextV1;
        SimVar.SetSimVarValue("L:AIRLINER_V1_SPEED", "Knots", nextV1);
    }

    _getVRSpeed() {
        /*let dWeightCoef = (this.getWeight(true) - 100) / (175 - 100);
        dWeightCoef = Utils.Clamp(dWeightCoef, 0, 1);
        dWeightCoef = 0.695 + (0.985 - 0.695) * dWeightCoef;

        const tempIndex = this._getTempIndex();
        const min = A320_Neo_CDU_MainDisplay._vRsConf1[tempIndex][0];
        const max = A320_Neo_CDU_MainDisplay._vRsConf1[tempIndex][1];

        return this._getVSpeed(dWeightCoef, min, max);*/
        return (new NXToSpeeds(SimVar.GetSimVarValue("TOTAL WEIGHT", "kg") / 1000, this.flaps, Simplane.getAltitude())).vr;
    }
    _computeVRSpeed() {
        // computeVRSpeed is called by inherited class so it must remain,
        // but we need the calculation logic so that sits in it's own function now.
        const nextVR = this._getVRSpeed();
        this.vRSpeed = nextVR;
        SimVar.SetSimVarValue("L:AIRLINER_VR_SPEED", "Knots", nextVR);
    }

    _getV2Speed() {
        /*let dWeightCoef = (this.getWeight(true) - 100) / (175 - 100);
        dWeightCoef = Utils.Clamp(dWeightCoef, 0, 1);
        dWeightCoef = 0.71 + (0.96 - 0.71) * dWeightCoef;

        const tempIndex = this._getTempIndex();
        const min = A320_Neo_CDU_MainDisplay._v2sConf1[tempIndex][0];
        const max = A320_Neo_CDU_MainDisplay._v2sConf1[tempIndex][1];

        return this._getVSpeed(dWeightCoef, min, max);*/
        return (new NXToSpeeds(SimVar.GetSimVarValue("TOTAL WEIGHT", "kg") / 1000, this.flaps, Simplane.getAltitude())).v2;
    }
    _computeV2Speed() {
        // computeV2Speed is called by inherited class so it must remain,
        // but we need the calculation logic so that sits in it's own function now.
        const nextV2 = this._getV2Speed();
        this.v2Speed = nextV2;
        SimVar.SetSimVarValue("L:AIRLINER_V2_SPEED", "Knots", nextV2);
    }

    getThrustTakeOffLimit() {
        if (this.perfTOTemp <= 10) {
            return 92.8;
        }
        if (this.perfTOTemp <= 40) {
            return 92.8;
        }
        if (this.perfTOTemp <= 45) {
            return 92.2;
        }
        if (this.perfTOTemp <= 50) {
            return 90.5;
        }
        if (this.perfTOTemp <= 55) {
            return 88.8;
        }
        return 88.4;
    }
    getThrustClimbLimit() {
        return this.getThrustTakeOffLimit() - 8;
    }
    isAirspeedManaged() {
        return SimVar.GetSimVarValue("AUTOPILOT SPEED SLOT INDEX", "number") === 2;
    }
    isHeadingManaged() {
        return SimVar.GetSimVarValue("AUTOPILOT HEADING SLOT INDEX", "number") === 2;
    }
    isAltitudeManaged() {
        return SimVar.GetSimVarValue("AUTOPILOT ALTITUDE SLOT INDEX", "number") === 2;
    }
    isVerticalSpeedManaged() {
        return SimVar.GetSimVarValue("AUTOPILOT VS SLOT INDEX", "number") === 2;
    }
    updateAutopilot() {
        const now = performance.now();
        const dt = now - this._lastUpdateAPTime;
        let apLogicOn = (this._apMasterStatus || Simplane.getAutoPilotFlightDirectorActive(1));
        this._lastUpdateAPTime = now;
        if (isFinite(dt)) {
            this.updateAutopilotCooldown -= dt;
        }
        if (SimVar.GetSimVarValue("L:AIRLINER_FMC_FORCE_NEXT_UPDATE", "number") === 1) {
            SimVar.SetSimVarValue("L:AIRLINER_FMC_FORCE_NEXT_UPDATE", "number", 0);
            this.updateAutopilotCooldown = -1;
        }
        if (apLogicOn && this.currentFlightPhase >= FlightPhase.FLIGHT_PHASE_TAKEOFF) {
            if (this.isHeadingManaged()) {
                const heading = SimVar.GetSimVarValue("GPS COURSE TO STEER", "degree", "FMC");
                if (isFinite(heading)) {
                    Coherent.call("HEADING_BUG_SET", 2, heading);
                }
            }
        }
        if (this.updateAutopilotCooldown < 0) {
            const currentApMasterStatus = SimVar.GetSimVarValue("AUTOPILOT MASTER", "boolean");
            if (currentApMasterStatus != this._apMasterStatus) {
                this._apMasterStatus = currentApMasterStatus;
                apLogicOn = (this._apMasterStatus || Simplane.getAutoPilotFlightDirectorActive(1));
                this._forceNextAltitudeUpdate = true;
                console.log("Enforce AP in Altitude Lock mode. Cause : AP Master Status has changed.");
                SimVar.SetSimVarValue("L:A320_NEO_FCU_FORCE_IDLE_VS", "Number", 1);
                if (this._apMasterStatus) {
                    if (this.flightPlanManager.getWaypointsCount() === 0) {
                        this._onModeSelectedAltitude();
                        this._onModeSelectedHeading();
                        this._onModeSelectedSpeed();
                    }
                }
            }
            if (apLogicOn) {
                if (!Simplane.getAutoPilotFLCActive() && !SimVar.GetSimVarValue("AUTOPILOT AIRSPEED HOLD", "Boolean")) {
                    SimVar.SetSimVarValue("K:AP_PANEL_SPEED_HOLD", "Number", 1);
                }
                if (!SimVar.GetSimVarValue("AUTOPILOT HEADING LOCK", "Boolean")) {
                    if (!SimVar.GetSimVarValue("AUTOPILOT APPROACH HOLD", "Boolean")) {
                        SimVar.SetSimVarValue("K:AP_PANEL_HEADING_HOLD", "Number", 1);
                    }
                }
            }
            const currentHasReachedFlex = Simplane.getEngineThrottleMode(0) >= ThrottleMode.FLEX_MCT && Simplane.getEngineThrottleMode(1) >= ThrottleMode.FLEX_MCT;
            if (currentHasReachedFlex != this._lastHasReachFlex) {
                this._lastHasReachFlex = currentHasReachedFlex;
                console.log("Current Has Reached Flex = " + currentHasReachedFlex);
                if (currentHasReachedFlex) {
                    if (!SimVar.GetSimVarValue("AUTOPILOT THROTTLE ARM", "boolean")) {
                        SimVar.SetSimVarValue("K:AUTO_THROTTLE_ARM", "number", 1);
                    }
                }
            }
            const currentAltitude = Simplane.getAltitude();
            const groundSpeed = Simplane.getGroundSpeed();
            const apTargetAltitude = Simplane.getAutoPilotAltitudeLockValue("feet");
            let showTopOfClimb = false;
            let topOfClimbLlaHeading;
            const planeHeading = Simplane.getHeadingMagnetic();
            const planeCoordinates = new LatLong(SimVar.GetSimVarValue("PLANE LATITUDE", "degree latitude"), SimVar.GetSimVarValue("PLANE LONGITUDE", "degree longitude"));
            if (apTargetAltitude > currentAltitude + 40) {
                const vSpeed = Simplane.getVerticalSpeed();
                const climbDuration = (apTargetAltitude - currentAltitude) / vSpeed / 60;
                const climbDistance = climbDuration * groundSpeed;
                if (climbDistance > 1) {
                    topOfClimbLlaHeading = this.flightPlanManager.getCoordinatesHeadingAtDistanceAlongFlightPlan(climbDistance);
                    if (topOfClimbLlaHeading) {
                        showTopOfClimb = true;
                    }
                }
            }
            if (showTopOfClimb) {
                SimVar.SetSimVarValue("L:AIRLINER_FMS_SHOW_TOP_CLIMB", "number", 1);
                SimVar.SetSimVarValue("L:AIRLINER_FMS_LAT_TOP_CLIMB", "number", topOfClimbLlaHeading.lla.lat);
                SimVar.SetSimVarValue("L:AIRLINER_FMS_LONG_TOP_CLIMB", "number", topOfClimbLlaHeading.lla.long);
                SimVar.SetSimVarValue("L:AIRLINER_FMS_HEADING_TOP_CLIMB", "number", topOfClimbLlaHeading.heading);
            } else {
                SimVar.SetSimVarValue("L:AIRLINER_FMS_SHOW_TOP_CLIMB", "number", 0);
            }
            SimVar.SetSimVarValue("SIMVAR_AUTOPILOT_AIRSPEED_MIN_CALCULATED", "knots", Simplane.getStallProtectionMinSpeed());
            SimVar.SetSimVarValue("SIMVAR_AUTOPILOT_AIRSPEED_MAX_CALCULATED", "knots", Simplane.getMaxSpeed(Aircraft.A320_NEO));
            if (this.isAltitudeManaged()) {
                const prevWaypoint = this.flightPlanManager.getPreviousActiveWaypoint();
                const nextWaypoint = this.flightPlanManager.getActiveWaypoint();
                if (prevWaypoint && nextWaypoint) {
                    let targetAltitude = nextWaypoint.legAltitude1;
                    if (nextWaypoint.legAltitudeDescription === 4) {
                        targetAltitude = Math.max(nextWaypoint.legAltitude1, nextWaypoint.legAltitude2);
                    }
                    let showTopOfDescent = false;
                    let topOfDescentLat;
                    let topOfDescentLong;
                    let topOfDescentHeading;
                    this._hasReachedTopOfDescent = true;
                    if (currentAltitude > targetAltitude + 40) {
                        let vSpeed = Math.abs(Math.min(0, Simplane.getVerticalSpeed()));
                        if (vSpeed < 200) {
                            vSpeed = 2000;
                        }
                        const descentDuration = Math.abs(targetAltitude - currentAltitude) / vSpeed / 60;
                        const descentDistance = descentDuration * groundSpeed;
                        const distanceToTarget = Avionics.Utils.computeGreatCircleDistance(prevWaypoint.infos.coordinates, nextWaypoint.infos.coordinates);
                        showTopOfDescent = true;
                        const f = 1 - descentDistance / distanceToTarget;
                        topOfDescentLat = Avionics.Utils.lerpAngle(prevWaypoint.infos.lat, nextWaypoint.infos.lat, f);
                        topOfDescentLong = Avionics.Utils.lerpAngle(prevWaypoint.infos.long, nextWaypoint.infos.long, f);
                        topOfDescentHeading = nextWaypoint.bearingInFP;
                        if (distanceToTarget + 1 > descentDistance) {
                            this._hasReachedTopOfDescent = false;
                        }
                    }
                    if (showTopOfDescent) {
                        SimVar.SetSimVarValue("L:AIRLINER_FMS_SHOW_TOP_DSCNT", "number", 1);
                        SimVar.SetSimVarValue("L:AIRLINER_FMS_LAT_TOP_DSCNT", "number", topOfDescentLat);
                        SimVar.SetSimVarValue("L:AIRLINER_FMS_LONG_TOP_DSCNT", "number", topOfDescentLong);
                        SimVar.SetSimVarValue("L:AIRLINER_FMS_HEADING_TOP_DSCNT", "number", topOfDescentHeading);
                    } else {
                        SimVar.SetSimVarValue("L:AIRLINER_FMS_SHOW_TOP_DSCNT", "number", 0);
                    }
                    this.tryUpdateConstraints();
                    if (this.constraintAlt) {
                        SimVar.SetSimVarValue("L:A32NX_AP_CSTN_ALT", "feet", this.constraintAlt);
                        Coherent.call("AP_ALT_VAR_SET_ENGLISH", 2, this.constraintAlt, this._forceNextAltitudeUpdate);
                        this._forceNextAltitudeUpdate = false;
                        SimVar.SetSimVarValue("L:AP_CURRENT_TARGET_ALTITUDE_IS_CONSTRAINT", "number", 1);
                    } else {
                        const altitude = Simplane.getAutoPilotSelectedAltitudeLockValue("feet");
                        if (isFinite(altitude)) {
                            Coherent.call("AP_ALT_VAR_SET_ENGLISH", 2, altitude, this._forceNextAltitudeUpdate);
                            this._forceNextAltitudeUpdate = false;
                            SimVar.SetSimVarValue("L:AP_CURRENT_TARGET_ALTITUDE_IS_CONSTRAINT", "number", 0);
                        }
                    }
                } else {
                    const altitude = Simplane.getAutoPilotSelectedAltitudeLockValue("feet");
                    if (isFinite(altitude)) {
                        Coherent.call("AP_ALT_VAR_SET_ENGLISH", 2, altitude, this._forceNextAltitudeUpdate);
                        this._forceNextAltitudeUpdate = false;
                        SimVar.SetSimVarValue("L:AP_CURRENT_TARGET_ALTITUDE_IS_CONSTRAINT", "number", 0);
                    }
                }
            }
            if (!this.flightPlanManager.isActiveApproach()) {
                const activeWaypoint = this.flightPlanManager.getActiveWaypoint();
                const nextActiveWaypoint = this.flightPlanManager.getNextActiveWaypoint();
                if (activeWaypoint && nextActiveWaypoint) {
                    let pathAngle = nextActiveWaypoint.bearingInFP - activeWaypoint.bearingInFP;
                    while (pathAngle < 180) {
                        pathAngle += 360;
                    }
                    while (pathAngle > 180) {
                        pathAngle -= 360;
                    }
                    const absPathAngle = 180 - Math.abs(pathAngle);
                    const airspeed = Simplane.getIndicatedSpeed();
                    if (airspeed < 400) {
                        const turnRadius = airspeed * 360 / (1091 * 0.36 / airspeed) / 3600 / 2 / Math.PI;
                        const activateDistance = Math.pow(90 / absPathAngle, 1.6) * turnRadius * 1.2;
                        ;
                        const distanceToActive = Avionics.Utils.computeGreatCircleDistance(planeCoordinates, activeWaypoint.infos.coordinates);
                        if (distanceToActive < activateDistance) {
                            this.flightPlanManager.setActiveWaypointIndex(this.flightPlanManager.getActiveWaypointIndex() + 1);
                        }
                    }
                }
            }
            if (Simplane.getAutoPilotAltitudeManaged() && SimVar.GetSimVarValue("L:A320_NEO_FCU_STATE", "number") != 1) {
                const currentWaypointIndex = this.flightPlanManager.getActiveWaypointIndex();
                if (currentWaypointIndex != this._lastRequestedFLCModeWaypointIndex) {
                    this._lastRequestedFLCModeWaypointIndex = currentWaypointIndex;
                    setTimeout(() => {
                        if (Simplane.getAutoPilotAltitudeManaged()) {
                            this._onModeManagedAltitude();
                        }
                    }, 1000);
                }
            }
            if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_TAKEOFF) {
                const n1 = this.getThrustTakeOffLimit() / 100;
                SimVar.SetSimVarValue("AUTOPILOT THROTTLE MAX THRUST", "number", n1);
                if (this.isAirspeedManaged()) {
                    // getCleanTakeOffSpeed is a final fallback and not truth to reality
                    const speed = isFinite(this.v2Speed) ? this.v2Speed + 10 : this.getCleanTakeOffSpeed();
                    this.setAPManagedSpeed(speed, Aircraft.A320_NEO);
                }

                //This breaks everything, not sure why (from 1.8.3 update)
                /* let altitude = Simplane.getAltitudeAboveGround();
                let n1 = 100;
                if (altitude < this.thrustReductionAltitude) {
                    n1 = this.getThrustTakeOffLimit() / 100;
                }
                else {
                    n1 = this.getThrustClimbLimit() / 100;
                }
                SimVar.SetSimVarValue("AUTOPILOT THROTTLE MAX THRUST", "number", n1); */

            } else if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_CLIMB) {
                let speed;
                if (SimVar.GetSimVarValue("L:A32NX_GOAROUND_PASSED", "bool") === 1) {
                    speed = this.getPerfGreenDotSpeed();
                    //delete override logic when we have valid nav data -aka goaround path- after goaround!
                    if (SimVar.GetSimVarValue("L:A32NX_GOAROUND_NAV_OVERRIDE", "bool") === 0) {
                        console.log("only once per goaround override to HDG selected");
                        SimVar.SetSimVarValue("L:A32NX_GOAROUND_NAV_OVERRIDE", "bool", 1);
                        this._onModeSelectedHeading();
                    }
                } else {
                    speed = this.getClbManagedSpeed();
                }
                if (this.isAirspeedManaged()) {
                    this.setAPManagedSpeed(speed, Aircraft.A320_NEO);
                }
            } else if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_CRUISE) {
                if (this.isAirspeedManaged()) {
                    const speed = this.getCrzManagedSpeed();
                    this.setAPManagedSpeed(speed, Aircraft.A320_NEO);
                }
                if (this.isAltitudeManaged()) {
                }
                /* let altitude = Simplane.getAltitudeAboveGround();
                let n1 = 100;
                if (altitude < this.thrustReductionAltitude) {
                    n1 = this.getThrustTakeOffLimit() / 100;
                }
                else {
                    n1 = this.getThrustClimbLimit() / 100;
                }
                SimVar.SetSimVarValue("AUTOPILOT THROTTLE MAX THRUST", "number", n1); */
            } else if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_DESCENT) {
                if (this.isAirspeedManaged()) {
                    const speed = this.getDesManagedSpeed();
                    this.setAPManagedSpeed(speed, Aircraft.A320_NEO);
                }
            } else if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_APPROACH) {
                if (this.isAirspeedManaged()) {
                    const ctn = this.getSpeedConstraint(false);
                    let speed = this.getManagedApproachSpeedMcdu();
                    let vls = this.getVApp();
                    if (isFinite(this.perfApprWindSpeed) && isFinite(this.perfApprWindHeading)) {
                        vls = NXSpeedsUtils.getVtargetGSMini(vls, NXSpeedsUtils.getHeadWindDiff(this._towerHeadwind));
                    }
                    if (ctn !== Infinity) {
                        vls = Math.max(vls, ctn);
                        speed = Math.max(speed, ctn);
                    }
                    SimVar.SetSimVarValue("L:A32NX_AP_APPVLS", "knots", vls);
                    this.setAPManagedSpeed(Math.max(speed, vls), Aircraft.A320_NEO);
                }
            }
            if (this.currentFlightPhase == FlightPhase.FLIGHT_PHASE_GOAROUND) {
                const eng1Running = SimVar.GetSimVarValue("ENG COMBUSTION:1", "bool");
                const eng2Running = SimVar.GetSimVarValue("ENG COMBUSTION:2", "bool");

                let maxSpeed;
                let speed;
                const gaInitSpeed = SimVar.GetSimVarValue("L:A32NX_GOAROUND_INIT_SPEED", "number");
                const gaAppSpeed = SimVar.GetSimVarValue("L:A32NX_GOAROUND_INIT_APP_SPEED", "number");

                if (eng1Running && eng2Running) {
                    maxSpeed = this.getVLS() + 25;
                } else {
                    maxSpeed = this.getVLS() + 15;
                }

                speed = Math.max(gaInitSpeed, gaAppSpeed);
                speed = Math.min(speed, maxSpeed);
                SimVar.SetSimVarValue("L:A32NX_TOGA_SPEED", "number", speed);

                if (this.isAirspeedManaged()) {
                    this.setAPManagedSpeed(speed, Aircraft.A320_NEO);
                }

                const selectedAltFCU = SimVar.GetSimVarValue("L:HUD_AP_SELECTED_ALTITUDE", "Number");

                if (apLogicOn) {
                    //depending if on HDR/TRK or NAV mode, select approriate Alt Mode (WIP)
                    //this._onModeManagedAltitude();
                    this._onModeSelectedAltitude();
                }
            }
            this.updateAutopilotCooldown = this._apCooldown;
        }
    }
    // Asobo's getManagedApproachSpeed uses incorrect getCleanApproachSpeed for flaps 0
    getManagedApproachSpeedMcdu() {
        switch (Simplane.getFlapsHandleIndex()) {
            case 0: return this.getPerfGreenDotSpeed();
            case 1: return this.getSlatApproachSpeed();
            case 4: return this.getVApp();
            default: return this.getFlapApproachSpeed();
        }
    }
    checkUpdateFlightPhase() {
        const airSpeed = SimVar.GetSimVarValue("AIRSPEED TRUE", "knots");
        const flapsHandlePercent = Simplane.getFlapsHandlePercent();
        const leftThrottleDetent = Simplane.getEngineThrottleMode(0);
        const rightThrottleDetent = Simplane.getEngineThrottleMode(1);
        const highestThrottleDetent = (leftThrottleDetent >= rightThrottleDetent) ? leftThrottleDetent : rightThrottleDetent;

        if (this.currentFlightPhase <= FlightPhase.FLIGHT_PHASE_TAKEOFF) {
            const isAirborne = !Simplane.getIsGrounded(); // TODO replace with proper flight mode in future
            const isTogaFlex = highestThrottleDetent === ThrottleMode.TOGA || highestThrottleDetent === ThrottleMode.FLEX_MCT;
            const flapsSlatsRetracted = (
                SimVar.GetSimVarValue("TRAILING EDGE FLAPS LEFT ANGLE", "degrees") === 0 &&
                SimVar.GetSimVarValue("TRAILING EDGE FLAPS RIGHT ANGLE", "degrees") === 0 &&
                SimVar.GetSimVarValue("LEADING EDGE FLAPS LEFT ANGLE", "degrees") === 0 &&
                SimVar.GetSimVarValue("LEADING EDGE FLAPS RIGHT ANGLE", "degrees") === 0
            );
            const pitchTakeoffEngaged = !isAirborne && isFinite(this.v2Speed) && isTogaFlex && !flapsSlatsRetracted;
            const isTakeOffValid = pitchTakeoffEngaged ||
                SimVar.GetSimVarValue("GPS GROUND SPEED", "knots") > 90 ||
                (
                    SimVar.GetSimVarValue("ENG N1 RPM:1", "Percent") >= 85 &&
                    SimVar.GetSimVarValue("ENG N1 RPM:2", "Percent") >= 85
                );

            //End preflight when takeoff power is applied and engines are running
            if (this.currentFlightPhase < FlightPhase.FLIGHT_PHASE_TAKEOFF && isTakeOffValid) {
                this.currentFlightPhase = FlightPhase.FLIGHT_PHASE_TAKEOFF;
            }

            //Reset to preflight in case of RTO
            if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_TAKEOFF && !isTakeOffValid) {
                this.currentFlightPhase = FlightPhase.FLIGHT_PHASE_PREFLIGHT;
                this.climbTransitionGroundAltitude = null;
            }
        }

        //Changes to climb phase when acceleration altitude is reached
        if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_TAKEOFF && airSpeed > 80) {
            const planeAltitudeMsl = Simplane.getAltitude();
            let accelerationAltitudeMsl = (this.accelerationAltitude || this.thrustReductionAltitude);

            if (!accelerationAltitudeMsl) {
                if (!this.climbTransitionGroundAltitude) {
                    const origin = this.flightPlanManager.getOrigin();
                    if (origin) {
                        this.climbTransitionGroundAltitude = origin.altitudeinFP;
                    }

                    if (!this.climbTransitionGroundAltitude) {
                        this.climbTransitionGroundAltitude = (parseInt(SimVar.GetSimVarValue("GROUND ALTITUDE", "feet")) || 0);
                    }
                }

                accelerationAltitudeMsl = this.climbTransitionGroundAltitude + parseInt(NXDataStore.get("CONFIG_ACCEL_ALT", "1500"));
            }

            if (planeAltitudeMsl > accelerationAltitudeMsl) {
                //console.log('switching to FLIGHT_PHASE_CLIMB: ' + JSON.stringify({planeAltitudeMsl, accelerationAltitudeMsl, prevPhase: this.currentFlightPhase}, null, 2));
                this.currentFlightPhase = FlightPhase.FLIGHT_PHASE_CLIMB;
                this.climbTransitionGroundAltitude = null;
            }
        }

        //(Mostly) Default Asobo logic
        if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_CLIMB) {
            let cruiseFlightLevel;
            let remainInClimb = false;
            if (SimVar.GetSimVarValue("L:A32NX_GOAROUND_PASSED", "bool") === 1) {
                const selectedAltFCU = SimVar.GetSimVarValue("L:HUD_AP_SELECTED_ALTITUDE", "Number");
                if (SimVar.GetSimVarValue("L:A32NX_CRZ_ALT_SET_INITIAL", "bool") == 1) {
                    cruiseFlightLevel = SimVar.GetSimVarValue("L:A32NX_NEW_CRZ_ALT", "number");
                } else {
                    cruiseFlightLevel = selectedAltFCU / 100;
                    remainInClimb = true;
                }
            }
            const altitude = SimVar.GetSimVarValue("PLANE ALTITUDE", "feet");
            cruiseFlightLevel = this.cruiseFlightLevel * 100;
            if (isFinite(cruiseFlightLevel)) {
                if (altitude >= 0.96 * cruiseFlightLevel) {
                    if (remainInClimb) {
                        //console.log('remaining in FLIGHT_PHASE_CLIMB (no new DEST/CRZ ALT) : ' + JSON.stringify({altitude, cruiseFlightLevel, prevPhase: this.currentFlightPhase}, null, 2));
                    } else {
                        //console.log('switching to FLIGHT_PHASE_CRUISE: ' + JSON.stringify({altitude, cruiseFlightLevel, prevPhase: this.currentFlightPhase}, null, 2));
                        this.currentFlightPhase = FlightPhase.FLIGHT_PHASE_CRUISE;
                        SimVar.SetSimVarValue("L:A32NX_GOAROUND_PASSED", "bool", 0);
                        Coherent.call("GENERAL_ENG_THROTTLE_MANAGED_MODE_SET", ThrottleMode.AUTO);
                    }
                }
            }
        }
        //(Mostly) Default Asobo logic
        if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_CRUISE) {
            const altitude = SimVar.GetSimVarValue("PLANE ALTITUDE", "feets");
            const cruiseFlightLevel = this.cruiseFlightLevel * 100;
            if (isFinite(cruiseFlightLevel)) {
                if (altitude < 0.94 * cruiseFlightLevel) {
                    //console.log('switching to FLIGHT_PHASE_DESCENT: ' + JSON.stringify({altitude, cruiseFlightLevel, prevPhase: this.currentFlightPhase}, null, 2));
                    this.currentFlightPhase = FlightPhase.FLIGHT_PHASE_DESCENT;
                    Coherent.call("GENERAL_ENG_THROTTLE_MANAGED_MODE_SET", ThrottleMode.AUTO);
                }
            }
        }
        //Default Asobo logic
        // Switches from any phase to APPR if less than 40 distance(?) from DEST
        if (this.flightPlanManager.getActiveWaypoint() === this.flightPlanManager.getDestination()) {
            if (SimVar.GetSimVarValue("L:FLIGHTPLAN_USE_DECEL_WAYPOINT", "number") != 1) {
                const lat = SimVar.GetSimVarValue("PLANE LATITUDE", "degree latitude");
                const long = SimVar.GetSimVarValue("PLANE LONGITUDE", "degree longitude");
                const planeLla = new LatLongAlt(lat, long);
                const dist = Avionics.Utils.computeGreatCircleDistance(planeLla, this.flightPlanManager.getDestination().infos.coordinates);
                if (dist < 40 && this.currentFlightPhase != FlightPhase.FLIGHT_PHASE_GOAROUND) {
                    this.connectIls();
                    this.flightPlanManager.activateApproach();
                    if (this.currentFlightPhase != FlightPhase.FLIGHT_PHASE_APPROACH) {
                        console.log('switching to tryGoInApproachPhase: ' + JSON.stringify({lat, long, dist, prevPhase: this.currentFlightPhase}, null, 2));
                        this.tryGoInApproachPhase();
                    }
                }
            }
        }
        //Default Asobo logic
        // Switches from any phase to APPR if less than 3 distance(?) from DECEL
        if (SimVar.GetSimVarValue("L:FLIGHTPLAN_USE_DECEL_WAYPOINT", "number") === 1) {
            if (this.currentFlightPhase != FlightPhase.FLIGHT_PHASE_APPROACH) {
                if (this.flightPlanManager.decelWaypoint) {
                    const lat = SimVar.GetSimVarValue("PLANE LATITUDE", "degree latitude");
                    const long = SimVar.GetSimVarValue("PLANE LONGITUDE", "degree longitude");
                    const planeLla = new LatLongAlt(lat, long);
                    const dist = Avionics.Utils.computeGreatCircleDistance(this.flightPlanManager.decelWaypoint.infos.coordinates, planeLla);
                    if (dist < 3 && this.currentFlightPhase != FlightPhase.FLIGHT_PHASE_GOAROUND) {
                        this.flightPlanManager._decelReached = true;
                        this._waypointReachedAt = SimVar.GetGlobalVarValue("ZULU TIME", "seconds");
                        if (Simplane.getAltitudeAboveGround() < 9500) {
                            this.tryGoInApproachPhase();
                        }
                    }
                }
            }
        }
        //Logic to switch from APPR to GOAROUND
        //another condition getIsGrounded < 30sec
        if (this.currentFlightPhase == FlightPhase.FLIGHT_PHASE_APPROACH && highestThrottleDetent == ThrottleMode.TOGA && flapsHandlePercent != 0 && !Simplane.getAutoPilotThrottleActive() && SimVar.GetSimVarValue("RADIO HEIGHT", "feets") < 2000) {

            this.currentFlightPhase = FlightPhase.FLIGHT_PHASE_GOAROUND;
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_GATRK_MODE", "bool", 0);
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_HDG_MODE", "bool", 0);
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_NAV_MODE", "bool", 0);
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_INIT_SPEED", "number", Simplane.getIndicatedSpeed());
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_INIT_APP_SPEED", "number", this.getVApp());
            //delete override logic when we have valid nav data -aka goaround path- after goaround!
            SimVar.SetSimVarValue("L:A32NX_GOAROUND_NAV_OVERRIDE", "bool", 0);

            if (SimVar.GetSimVarValue("AUTOPILOT MASTER", "Bool") === 1) {
                SimVar.SetSimVarValue("K:AP_LOC_HOLD_ON", "number", 1); // Turns AP localizer hold !!ON/ARMED!! and glide-slope hold mode !!OFF!!
                SimVar.SetSimVarValue("K:AP_LOC_HOLD_OFF", "number", 1); // Turns !!OFF!! localizer hold mode
                SimVar.SetSimVarValue("K:AUTOPILOT_OFF", "number", 1);
                SimVar.SetSimVarValue("K:AUTOPILOT_ON", "number", 1);
                SimVar.SetSimVarValue("L:A32NX_AUTOPILOT_APPR_MODE", "bool", 0);
                SimVar.SetSimVarValue("L:A32NX_AUTOPILOT_LOC_MODE", "bool", 0);
            } else if (SimVar.GetSimVarValue("AUTOPILOT MASTER", "Bool") === 0 && SimVar.GetSimVarValue("AUTOPILOT APPROACH HOLD", "boolean") === 1) {
                SimVar.SetSimVarValue("AP_APR_HOLD_OFF", "number", 1);
                SimVar.SetSimVarValue("L:A32NX_AUTOPILOT_APPR_MODE", "bool", 0);
                SimVar.SetSimVarValue("L:A32NX_AUTOPILOT_LOC_MODE", "bool", 0);
            }

            const currentHeading = Simplane.getHeadingMagnetic();
            Coherent.call("HEADING_BUG_SET", 1, currentHeading);

            CDUPerformancePage.ShowGOAROUNDPage(this);
        }

        //Logic to switch back from GOAROUND to CLB/CRZ
        //When missed approach or sec fpl are implemented this needs rework
        //Exit Scenario after successful GOAROUND
        if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_GOAROUND) {
            if (highestThrottleDetent === ThrottleMode.FLEX_MCT) {
                SimVar.SetSimVarValue("L:A32NX_GOAROUND_NAV_MODE", "bool", 1);
            }

            const planeAltitudeMsl = Simplane.getAltitude();
            const accelerationAltitudeMsl = this.accelerationAltitudeGoaround;

            if (planeAltitudeMsl > accelerationAltitudeMsl) {
                //console.log('switching to FLIGHT_PHASE_CLIMB from GA: ' + JSON.stringify({planeAltitudeMsl, accelerationAltitudeMsl, prevPhase: this.currentFlightPhase}, null, 2));
                this.currentFlightPhase = FlightPhase.FLIGHT_PHASE_CLIMB;
                SimVar.SetSimVarValue("L:A32NX_GOAROUND_PASSED", "bool", 1);
            }
        }

        //Resets flight phase to preflight 30 seconds after touchdown
        if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_APPROACH && Simplane.getAltitudeAboveGround() < 1.5) {
            if (this.landingResetTimer == null) {
                this.landingResetTimer = 30;
            }
            if (this.landingAutoBrakeTimer == null) {
                this.landingAutoBrakeTimer = SimVar.GetSimVarValue("L:XMLVAR_Autobrakes_Level", "Enum") === 1 ? 4 : 2;
            }
            if (this.lastPhaseUpdateTime == null) {
                this.lastPhaseUpdateTime = Date.now();
            }
            const deltaTime = Date.now() - this.lastPhaseUpdateTime;
            const deltaQuotient = deltaTime / 1000;
            this.lastPhaseUpdateTime = Date.now();
            this.landingResetTimer -= deltaQuotient;
            this.landingAutoBrakeTimer -= deltaQuotient;
            if (this.landingAutoBrakeTimer <= 0) {
                this.landingAutoBrakeTimer = null;
                SimVar.SetSimVarValue("L:A32NX_AUTOBRAKES_BRAKING", "Bool", 1);
            }
            if (this.landingResetTimer <= 0) {
                this.landingResetTimer = null;
                this.currentFlightPhase = FlightPhase.FLIGHT_PHASE_PREFLIGHT;
                SimVar.SetSimVarValue("L:A32NX_TO_CONFIG_NORMAL", "Bool", 0);
                CDUIdentPage.ShowPage(this);
            }
        } else {
            //Reset timer to 30 when airborne in case of go around
            this.landingResetTimer = 30;
            this.landingAutoBrakeTimer = SimVar.GetSimVarValue("L:XMLVAR_Autobrakes_Level", "Enum") === 1 ? 4 : 2;
        }

        if (SimVar.GetSimVarValue("L:AIRLINER_FLIGHT_PHASE", "number") !== this.currentFlightPhase) {
            this.landingAutoBrakeTimer = null;
            SimVar.SetSimVarValue("L:AIRLINER_FLIGHT_PHASE", "number", this.currentFlightPhase);
            this.onFlightPhaseChanged();
            SimVar.SetSimVarValue("L:A32NX_CABIN_READY", "Bool", 0);
        }
    }
    checkAocTimes() {
        if (!this.aocTimes.off) {
            const isAirborne = !Simplane.getIsGrounded(); // TODO replace with proper flight mode in future
            if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_TAKEOFF && isAirborne) {
                // Wheels off
                // Off: remains blank until Take off time
                const seconds = Math.floor(SimVar.GetGlobalVarValue("ZULU TIME", "seconds"));
                this.aocTimes.off = seconds;
            }
        }

        if (!this.aocTimes.out) {
            const currentPKGBrakeState = SimVar.GetSimVarValue("BRAKE PARKING POSITION", "Bool");
            if (this.currentFlightPhase === FlightPhase.FLIGHT_PHASE_PREFLIGHT && !currentPKGBrakeState) {
                // Out: is when you set the brakes to off
                const seconds = Math.floor(SimVar.GetGlobalVarValue("ZULU TIME", "seconds"));
                this.aocTimes.out = seconds;
            }
        }

        if (!this.aocTimes.on) {
            const isAirborne = !Simplane.getIsGrounded(); // TODO replace with proper flight mode in future
            if (this.aocTimes.off && !isAirborne) {
                // On: remains blank until Landing time
                const seconds = Math.floor(SimVar.GetGlobalVarValue("ZULU TIME", "seconds"));
                this.aocTimes.on = seconds;
            }
        }

        if (!this.aocTimes.in) {
            const currentPKGBrakeState = SimVar.GetSimVarValue("BRAKE PARKING POSITION", "Bool");
            const cabinDoorPctOpen = SimVar.GetSimVarValue("INTERACTIVE POINT OPEN:0", "percent");
            if (this.aocTimes.on && currentPKGBrakeState && cabinDoorPctOpen > 20) {
                // In: remains blank until brakes set to park AND the first door opens
                const seconds = Math.floor(SimVar.GetGlobalVarValue("ZULU TIME", "seconds"));
                this.aocTimes.in = seconds;
            }
        }

        if (this.currentFlightPhase == FlightPhase.FLIGHT_PHASE_PREFLIGHT) {
            const cabinDoorPctOpen = SimVar.GetSimVarValue("INTERACTIVE POINT OPEN:0", "percent");
            if (!this.aocTimes.doors && cabinDoorPctOpen < 20) {
                const seconds = Math.floor(SimVar.GetGlobalVarValue("ZULU TIME", "seconds"));
                this.aocTimes.doors = seconds;
            } else {
                if (cabinDoorPctOpen > 20) {
                    this.aocTimes.doors = "";
                }
            }
        }
    }

    // INCOMING AOC MESSAGES
    getMessages() {
        return this.messages;
    }
    getMessage(id, type) {
        const messages = this.messages;
        const currentMessageIndex = messages.findIndex(m => m["id"].toString() === id.toString());
        if (type === 'previous') {
            if (messages[currentMessageIndex - 1]) {
                return messages[currentMessageIndex - 1];
            }
            return null;
        } else if (type === 'next') {
            if (messages[currentMessageIndex + 1]) {
                return messages[currentMessageIndex + 1];
            }
            return null;
        }
        return messages[currentMessageIndex];
    }
    getMessageIndex(id) {
        return this.messages.findIndex(m => m["id"].toString() === id.toString());
    }
    addMessage(message) {
        this.messages.unshift(message);
        const cMsgCnt = SimVar.GetSimVarValue("L:A32NX_COMPANY_MSG_COUNT", "Number");
        SimVar.SetSimVarValue("L:A32NX_COMPANY_MSG_COUNT", "Number", cMsgCnt + 1);
    }
    deleteMessage(id) {
        if (!this.messages[id]["opened"]) {
            const cMsgCnt = SimVar.GetSimVarValue("L:A32NX_COMPANY_MSG_COUNT", "Number");
            SimVar.SetSimVarValue("L:A32NX_COMPANY_MSG_COUNT", "Number", cMsgCnt <= 1 ? 0 : cMsgCnt - 1);
        }
        this.messages.splice(id, 1);
    }

    // OUTGOING/SENT AOC MESSAGES
    getSentMessages() {
        return this.sentMessages;
    }
    getSentMessage(id, type) {
        const messages = this.sentMessages;
        const currentMessageIndex = messages.findIndex(m => m["id"].toString() === id.toString());
        if (type === 'previous') {
            if (messages[currentMessageIndex - 1]) {
                return messages[currentMessageIndex - 1];
            }
            return null;
        } else if (type === 'next') {
            if (messages[currentMessageIndex + 1]) {
                return messages[currentMessageIndex + 1];
            }
            return null;
        }
        return messages[currentMessageIndex];
    }
    getSentMessageIndex(id) {
        return this.sentMessages.findIndex(m => m["id"].toString() === id.toString());
    }
    addSentMessage(message) {
        this.sentMessages.unshift(message);
    }
    deleteSentMessage(id) {
        this.sentMessages.splice(id, 1);
    }
}
A320_Neo_CDU_MainDisplay._v1sConf1 = [
    [145, 149],
    [143, 151],
    [141, 152],
    [139, 150],
    [137, 147],
    [136, 145],
    [134, 143],
    [134, 142],
    [133, 142],
    [133, 143],
    [133, 144],
    [132, 145],
    [132, 146],
    [132, 146],
    [132, 147],
    [131, 148],
    [131, 148],
    [131, 149],
    [130, 150],
    [130, 150],
];
A320_Neo_CDU_MainDisplay._v1sConf2 = [
    [130, 156],
    [128, 154],
    [127, 151],
    [125, 149],
    [123, 147],
    [122, 145],
    [121, 143],
    [120, 143],
    [120, 143],
    [120, 142],
    [119, 142],
    [119, 142],
    [119, 142],
    [119, 141],
    [118, 141],
    [118, 141],
    [118, 140],
    [118, 140],
    [117, 140],
    [117, 140],
];
A320_Neo_CDU_MainDisplay._vRsConf1 = [
    [146, 160],
    [144, 160],
    [143, 159],
    [141, 158],
    [139, 156],
    [137, 154],
    [136, 152],
    [135, 151],
    [135, 151],
    [134, 151],
    [134, 151],
    [133, 151],
    [133, 151],
    [132, 150],
    [132, 151],
    [131, 151],
    [131, 150],
    [131, 150],
    [130, 151],
    [130, 150],
];
A320_Neo_CDU_MainDisplay._vRsConf2 = [
    [130, 158],
    [128, 156],
    [127, 154],
    [125, 152],
    [123, 150],
    [122, 148],
    [121, 147],
    [120, 146],
    [120, 146],
    [120, 145],
    [119, 145],
    [119, 144],
    [119, 144],
    [119, 143],
    [118, 143],
    [118, 142],
    [118, 142],
    [118, 141],
    [117, 141],
    [117, 140],
];
A320_Neo_CDU_MainDisplay._v2sConf1 = [
    [152, 165],
    [150, 165],
    [148, 164],
    [146, 163],
    [144, 161],
    [143, 159],
    [141, 157],
    [140, 156],
    [140, 156],
    [139, 156],
    [139, 155],
    [138, 155],
    [138, 155],
    [137, 155],
    [137, 155],
    [136, 155],
    [136, 155],
    [136, 155],
    [135, 155],
    [135, 155],
];
A320_Neo_CDU_MainDisplay._v2sConf2 = [
    [135, 163],
    [133, 160],
    [132, 158],
    [130, 157],
    [129, 155],
    [127, 153],
    [127, 151],
    [126, 150],
    [125, 150],
    [125, 149],
    [124, 149],
    [124, 148],
    [124, 148],
    [123, 147],
    [123, 146],
    [123, 146],
    [123, 145],
    [122, 145],
    [122, 144],
    [121, 144],
];
registerInstrument("a320-neo-cdu-main-display", A320_Neo_CDU_MainDisplay);
