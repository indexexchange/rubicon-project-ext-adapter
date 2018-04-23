/**
 * @author:    Partner
 * @license:   UNLICENSED
 *
 * @copyright: Copyright (c) 2018 by Index Exchange. All rights reserved.
 *
 * The information contained within this document is confidential, copyrighted
 * and or a trade secret. No part of this document may be reproduced or
 * distributed in any form or by any means, in whole or in part, without the
 * prior written permission of Index Exchange.
 */

'use strict';

////////////////////////////////////////////////////////////////////////////////
// Dependencies ////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

var Browser = require('browser.js');
var Classify = require('classify.js');
var Constants = require('constants.js');
var Network = require('network.js');
var Partner = require('partner.js');
var Prms = require('prms.js');
var Size = require('size.js');
var SpaceCamp = require('space-camp.js');
var System = require('system.js');
var Utilities = require('utilities.js');
var Whoopsie = require('whoopsie.js');
var EventsService;
var RenderService;
var TimerService;

//? if (DEBUG) {
var ConfigValidators = require('config-validators.js');
var Inspector = require('schema-inspector.js');
var PartnerSpecificValidator = require('rubicon-htb-validator.js');
var Scribe = require('scribe.js');
//? }

////////////////////////////////////////////////////////////////////////////////
// Main ////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
/**
 * The Rubicon Extended Htb
 *
 * @class
 */
function RubiconExtHtb(configs) {

    /* Rubicon endpoint only works with AJAX */
    if (!Network.isXhrSupported()) {
        //? if (DEBUG) {
        Scribe.warn('Partner RubiconExtHtb requires AJAX support. Aborting instantiation.');
        //? }

        return null;
    }

    /* =====================================
     * Data
     * ---------------------------------- */

    /* Private
     * ---------------------------------- */

    /**
     * Reference to the partner base class.
     *
     * @private {object}
     */
    var __baseClass;

    /**
     * Profile for this partner.
     *
     * @private {object}
     */
    var __profile;

    /**
     * Mapping of sizes to rubicon size IDs
     *
     * @private {object}
     */
    var __sizeToSizeIdMapping;

    /**
     * Mapping of rubicon slot names to returnParcels
     *
     * @private {object}
     */
    var __rubiconSlotToParcel;

    /**
     * Variable to keep track of whether a request has been timedOut.
     * @private
     * @type {Object}
     */
    var __timedOut;

    /**
     * Reference to the rubiconTag library.
     * @private
     * @type {Object}
     */
    var __rubiconTag;

    /* =====================================
     * Functions
     * ---------------------------------- */

    /* Utilities
     * ---------------------------------- */

    /**
     * Translates an array of size arrays to an array of Rubicon size IDs
     * @param  {array} sizes [description]
     * @return {array}       [description]
     */
    function __mapSizesToRubiconSizeIds(sizes) {
        var rubiSizeIds = [];

        for (var i = 0; i < sizes.length; i++) {
            var sizeKey = Size.arrayToString(sizes[i]);
            if (__sizeToSizeIdMapping.hasOwnProperty(sizeKey)) {
                rubiSizeIds.push(__sizeToSizeIdMapping[sizeKey]);
            } else {
                //? if(DEBUG) {
                Scribe.warn('No rubicon size id for size ' + sizeKey);
                //? }
            }
        }

        return rubiSizeIds;
    }

    function __transformFpdSubobject(subobject) {
        var returnSubobject = {};

        if (subobject.vars) {
            var vars = subobject.vars;

            for (var varsKey in vars) {
                if (!vars.hasOwnProperty(varsKey)) {
                    continue;
                }

                returnSubobject[varsKey] = returnSubobject[varsKey] || [];

                for (var i = 0; i < vars[varsKey].length; i++) {
                    var evaledVariable = Utilities.evalVariable(vars[varsKey][i]);

                    if (evaledVariable !== null && evaledVariable !== undefined) {
                        returnSubobject[varsKey].push(evaledVariable);
                    }
                }
            }
        }

        if (subobject.strs) {
            var strs = subobject.strs;

            for (var strsKey in strs) {
                if (!strs.hasOwnProperty(strsKey)) {
                    continue;
                }

                returnSubobject[strsKey] = returnSubobject[strsKey] || [];

                for (var j = 0; j < strs[strsKey].length; j++) {
                    returnSubobject[strsKey].push(strs[strsKey][j]);
                }
            }
        }

        if (subobject.fns) {
            var fns = subobject.fns;

            for (var fnsKey in fns) {
                if (!fns.hasOwnProperty(fnsKey)) {
                    continue;
                }

                returnSubobject[fnsKey] = returnSubobject[fnsKey] || [];

                var evaledValue = Utilities.evalFunction(fns[fnsKey].fn, fns[fnsKey].args);

                if (evaledValue !== null && evaledValue !== undefined) {
                    if (Utilities.isArray(evaledValue)) {
                        for (var k = 0; k < evaledValue.length; k++) {
                            returnSubobject[fnsKey].push(evaledValue[k]);
                        }
                    } else {
                        returnSubobject[fnsKey].push(evaledValue);
                    }
                }
            }
        }

        return returnSubobject;
    }

    function __transformFirstPartyData(fpdObject) {
        var firstPartyData = {};

        if (fpdObject.inventory) {
            firstPartyData.inventory = __transformFpdSubobject(fpdObject.inventory);
        }
        if (fpdObject.visitor) {
            firstPartyData.visitor = __transformFpdSubobject(fpdObject.visitor);
        }
        if (fpdObject.position) {
            firstPartyData.position = fpdObject.position;
        }
        if (fpdObject.keywords) {
            if (Utilities.isString(fpdObject.keywords)) {
                firstPartyData.keywords = [fpdObject.keywords];
            } else {
                firstPartyData.keywords = fpdObject.keywords;
            }
        }

        return firstPartyData;
    }

    /**
     * Returns a unique timeout  callback based on the provided sessionId, used by the timer service.
     * @param  {Object} sessionId The current session identifier.
     * @param  {Object} requestId The current request identifier.
     * @param  {Object} returnParcels The returnParcels for this request.
     * @param  {Object} xSlotNames The remaining xSlots.
     * @param  {Object} defer The defer object for this request.
     */

    function __generateTimeoutCallback(sessionId, requestId, returnParcels, xSlotNames, defer) {
        return function () {

            /* If doesnt need to be timed out or already timed out, dont do anything. */
            if (!__timedOut.hasOwnProperty(requestId) || __timedOut[requestId] === true) {
                return;
            }

            __timedOut[requestId] = true;

            if (__profile.enabledAnalytics.requestTime) {
                EventsService.emit('partner_request_complete', {
                    partner: __profile.partnerId,
                    status: 'timeout',
                    //? if (DEBUG) {
                    parcels: returnParcels,
                    //? }
                });

                __baseClass._emitStatsEvent(sessionId, 'hs_slot_timeout', xSlotNames);
            }
            defer.resolve(returnParcels);
        };
    }

    /**
     * This function will render the ad given using the Rubicon library
     *
     * @param  {Object} doc       The document of the iframe where the ad will go.
     * @param  {string} elementId  The rubicon slot elementId
     * @param  {Number} sizeId     The rubicon slot sizeId
     */
    function __render(doc, elementId, sizeId) {
        __rubiconTag.renderCreative(doc.body, elementId, sizeId);
    }

    /* Helpers
     * ---------------------------------- */

    /**
     *
     * Apply first party data to to the page.
     *
     * @param {object} pageFirstPartyData
     */
    function __applyPageFpd(pageFirstPartyData) {
        /* Apply first party page data. */
        for (var pageInv in pageFirstPartyData.inventory) {
            if (!pageFirstPartyData.inventory.hasOwnProperty(pageInv)) {
                continue;
            }

            __rubiconTag.setFPI(pageInv, pageFirstPartyData.inventory[pageInv].toString());
        }

        for (var pageVis in pageFirstPartyData.visitor) {
            if (!pageFirstPartyData.visitor.hasOwnProperty(pageVis)) {
                continue;
            }

            __rubiconTag.setFPV(pageVis, pageFirstPartyData.visitor[pageVis].toString());
        }

        if (pageFirstPartyData.keywords) {
            __rubiconTag.addKW(pageFirstPartyData.keywords.toString());
        }
    }

    /**
     *
     * Apply slot first party data firstPartyData to rubiconSlot.
     *
     * @param {object} rubiconSlot
     * @param {object} slotFirstPartyData
     */
    function __applySlotFpd(rubiconSlot, slotFirstPartyData) {

        /* Apply first party data for slot. */
        for (var slotInv in slotFirstPartyData.inventory) {
            if (!slotFirstPartyData.inventory.hasOwnProperty(slotInv)) {
                continue;
            }

            rubiconSlot.addFPI(slotInv, slotFirstPartyData.inventory[slotInv].toString());
        }

        for (var slotVis in slotFirstPartyData.visitor) {
            if (!slotFirstPartyData.visitor.hasOwnProperty(slotVis)) {
                continue;
            }

            rubiconSlot.addFPV(slotVis, slotFirstPartyData.visitor[slotVis].toString());
        }

        if (slotFirstPartyData.keywords) {
            rubiconSlot.addKW(slotFirstPartyData.keywords.toString());
        }

        if (slotFirstPartyData.position) {
            rubiconSlot.setPosition(slotFirstPartyData.position);
        }
    }

    /**
     *
     * Define a rubicon slot based on the returnParcel provided, attach
     * any slot first party data, and add it to the rubiconSlot to parcel
     * mapping.
     *
     * @param {any} returnParcel [Return parcel to be used for rubiconSlot]
     * @return {object}          [The generated rubiconSlot]
     */
    function __createRubiconSlot(returnParcel) {
        /**
         * Arbitrary unique ID for rubicon slot. Currently set to be the divId of the requested google
         * slot.
         */
        var rubiconElementId = System.generateUniqueId();

        var xSlot = returnParcel.xSlotRef;

        var rubiconSlot = __rubiconTag.defineSlot({
            siteId: xSlot.siteId,
            zoneId: xSlot.zoneId,
            sizes: __mapSizesToRubiconSizeIds(xSlot.sizes),
            id: rubiconElementId
        });

        /* Add to mapping between rubiconSlot and returnParcel */
        __rubiconSlotToParcel[rubiconElementId] = returnParcel;

        return rubiconSlot;
    }

    /**
     * Get targeting data from rubicontag and apply it to returnParcels.
     * @param  {Object} sessionId The current session identifier.
     * @param  {string} returnParcels The parcels that will be returned.
     * @param  {string} outstandingXSlotNames The remaining xSlots.
     * @param  {Object} rubiconSlot The required rubiconSlot.
     */
    function __parseResponse(sessionId, returnParcels, outstandingXSlotNames, rubiconSlot) {

        /**
         * Find matching return parcel for this rubiconSlot.
         */
        var rubiconElementId = rubiconSlot.getElementId();
        var curReturnParcel = __rubiconSlotToParcel[rubiconElementId];
        if (!curReturnParcel) {
            return;
        }
        delete __rubiconSlotToParcel[rubiconElementId];
        var htSlotId = curReturnParcel.htSlot.getId();

        /* Bid Error */
        if (!rubiconSlot.hasOwnProperty('getRawResponses') || !rubiconSlot.hasOwnProperty('getAdServerTargeting')) {
            //? if (DEBUG) {
            Scribe.warn('Rubicon did not return bid data for ' + curReturnParcel.xSlotRef.zoneId);
            //? }

            if (__profile.enabledAnalytics.requestTime) {
                EventsService.emit('hs_slot_error', {
                    sessionId: sessionId,
                    statsId: __profile.statsId,
                    htSlotId: htSlotId,
                    requestId: curReturnParcel.requestId,
                    xSlotNames: [curReturnParcel.xSlotName]
                });
            }

            if (outstandingXSlotNames[htSlotId] && outstandingXSlotNames[htSlotId][curReturnParcel.requestId]) {
                Utilities.arrayDelete(outstandingXSlotNames[htSlotId][curReturnParcel.requestId], curReturnParcel.xSlotName);
            }

            return;
        }

        /* Get rubicon raw bid data from the rubiconSlot */
        var bids = rubiconSlot.getRawResponses();
        var targeting = rubiconSlot.getAdServerTargeting();

        /* Bid Pass */
        if (!bids.length || !targeting.length) {
            curReturnParcel.pass = true;
        }

        /* Iterate through the returned bids, one bid per size */
        for (var j = 0; j < bids.length; j++) {
            var curBid = bids[j];

            /* A rubicon slot may have more than one size, so we might need to return more than
            one parcel */
            if (j !== 0) {

                /* If there is more than one bid, we have to create new parcels that are basically copies
                of the first parcel that was mapped to this rubicon slot. */
                curReturnParcel = {
                    partnerId: curReturnParcel.partnerId,
                    htSlot: curReturnParcel.htSlot,
                    ref: curReturnParcel.ref,
                    xSlotRef: curReturnParcel.xSlotRef,
                    xSlotName: curReturnParcel.xSlotName,
                    requestId: curReturnParcel.requestId,
                };
                returnParcels.push(curReturnParcel);
            }

            var bidPrice = Number(curBid.cpm) || 0;

            /* Bid Pass */
            if (!Utilities.isNumber(bidPrice) || bidPrice <= 0) {
                //? if (DEBUG) {
                Scribe.info(__profile.partnerId + ' returned no demand for { zoneId: ' + curReturnParcel.xSlotRef.zoneId + ' }.');
                //? }

                curReturnParcel.pass = true;
                continue;
            }

            /* Bid Response */
            if (__profile.enabledAnalytics.requestTime) {

                EventsService.emit('hs_slot_bid', {
                    sessionId: sessionId,
                    statsId: __profile.statsId,
                    htSlotId: htSlotId,
                    requestId: curReturnParcel.requestId,
                    xSlotNames: [curReturnParcel.xSlotName]
                });

                if (outstandingXSlotNames[htSlotId] && outstandingXSlotNames[htSlotId][curReturnParcel.requestId]) {
                    Utilities.arrayDelete(outstandingXSlotNames[htSlotId][curReturnParcel.requestId], curReturnParcel.xSlotName);
                }
            }

            curReturnParcel.size = curBid.dimensions;
            curReturnParcel.targetingType = 'slot';
            curReturnParcel.targeting = {};

            //? if(FEATURES.GPT_LINE_ITEMS) {
            if (j === 0) {
                for (var q = 0; q < targeting.length; q++) {
                    curReturnParcel.targeting[targeting[q].key] = targeting[q].values;
                }
            }
            //? }

            //? if(FEATURES.RETURN_CREATIVE) {
            curReturnParcel.adm = '';
            //? }

            //? if(FEATURES.RETURN_PRICE) {
            curReturnParcel.price = Number(__baseClass._bidTransformers.price.apply(bidPrice));
            //? }

            //? if(FEATURES.INTERNAL_RENDER) {
            var pubKitAdId = SpaceCamp.services.RenderService.registerAd(
                sessionId,
                __profile.partnerId,
                __render, [rubiconSlot.getElementId(), __sizeToSizeIdMapping[Size.arrayToString(curBid.dimensions)]],
                '',
                __profile.features.demandExpiry.enabled ? (__profile.features.demandExpiry.value + System.now()) : 0
            );
            curReturnParcel.targeting.pubKitAdId = pubKitAdId;
            //? }
        }

        if (__profile.enabledAnalytics.requestTime) {
            __baseClass._emitStatsEvent(sessionId, 'hs_slot_pass', outstandingXSlotNames);
        }
    }

    /* Main
     * ---------------------------------- */

    function __sendDemandRequest(sessionId, returnParcels) {
        /* Create a new deferred promise */
        var defer = Prms.defer();

        /* Initialize requestId and timedOut variable to keep track of this request */
        var requestId = System.generateUniqueId();
        __timedOut[requestId] = false;

        /* Push the request onto the command queue in case rubicontag loads late. */
        __baseClass._pushToCommandQueue(function () {

            /* Check with timer service to see if session is still in progress */
            if (TimerService.getTimerState(sessionId) === TimerService.TimerStates.TERMINATED) {
                return;
            }

            /* Generate rubicon slot and xSlots based on the returnParcels */
            var xSlotNames = {};

            /**
             * MRA partners get an array containing a single parcel.
             */
            var curReturnParcel = returnParcels[0];

            /* Build xSlotNames for headerstats */
            var htSlotId = curReturnParcel.htSlot.getId();

            if (!xSlotNames.hasOwnProperty(htSlotId)) {
                xSlotNames[htSlotId] = {};
            }
            if (!xSlotNames[htSlotId].hasOwnProperty(curReturnParcel.requestId)) {
                xSlotNames[htSlotId][curReturnParcel.requestId] = [];
            }
            xSlotNames[htSlotId][curReturnParcel.requestId].push(curReturnParcel.xSlotName);

            /* Create rubicon slot based on current return parcel */
            var rubiconSlot = __createRubiconSlot(curReturnParcel);

            /* If there is any slot FPD to apply, apply it on the slot here */
            var slotFirstPartyData = {};

            /* Get first party slot data from the parcel/xSlot. */
            if (curReturnParcel.firstPartyData && curReturnParcel.firstPartyData.rubicon) {
                slotFirstPartyData = curReturnParcel.firstPartyData.rubicon;
            } else if (curReturnParcel.xSlotRef.slotFpd) {
                slotFirstPartyData = __transformFirstPartyData(curReturnParcel.xSlotRef.slotFpd);
            }

            __applySlotFpd(rubiconSlot, slotFirstPartyData);

            /* Generate a timeout function to timeout yieldbot */
            var timeoutCallback = __generateTimeoutCallback(sessionId, requestId, returnParcels, xSlotNames, defer);
            SpaceCamp.services.TimerService.addTimerCallback(sessionId, timeoutCallback);
            if (__baseClass._configs.timeout) {
                setTimeout(timeoutCallback, __baseClass._configs.timeout);
            }

            /* Emit stat events for partner requests */
            EventsService.emit('partner_request_sent', {
                partner: __profile.partnerId,
                //? if (DEBUG) {
                parcels: returnParcels
                //? }
            });

            if (__profile.enabledAnalytics.requestTime) {
                __baseClass._emitStatsEvent(sessionId, 'hs_slot_request', xSlotNames);
            }

            /* Call rubicontag.run to start getting demand for the required slot */
            __rubiconTag.run(function () {
                if (__timedOut[requestId]) {
                    return;
                }

                /* Signal that partner request was complete */
                EventsService.emit('partner_request_complete', {
                    partner: __profile.partnerId,
                    status: 'success',
                    //? if (DEBUG) {
                    parcels: returnParcels,
                    //? }
                });

                delete __timedOut[requestId];
                __parseResponse(sessionId, returnParcels, xSlotNames, rubiconSlot);
                defer.resolve(returnParcels);
            }, {
                timeout: __baseClass._configs.timeout,
                slots: [rubiconSlot]
            });

        });

        return defer.promise;
    }

    /**
     * Public function to internally set page-level first party data.
     *
     * @param {object} data [first party page data]
     */
    function setFirstPartyData(data) {
        //? if (DEBUG){
        var results = Inspector.validate({
            type: 'object',
            strict: true,
            properties: {
                keywords: {
                    optional: true,
                    type: 'array',
                    items: {
                        type: 'string'
                    }
                },
                inventory: {
                    optional: true,
                    properties: {
                        '*': {
                            type: 'array',
                            items: {
                                type: 'string'
                            }
                        }
                    }
                },
                visitor: {
                    optional: true,
                    properties: {
                        '*': {
                            type: 'array',
                            items: {
                                type: 'string'
                            }
                        }
                    }
                }
            }
        }, data);
        if (!results.valid) {
            throw Whoopsie('INVALID_ARGUMENT', results.format());
        }
        //? }

        __applyPageFpd(data);
    }

    /* Retrieve demand for all slots in inParcels */
    function __retriever(sessionId, inParcels) {
        var returnParcelSets = __baseClass._generateReturnParcels(inParcels);
        var demandRequestPromises = [];

        for (var i = 0; i < returnParcelSets.length; i++) {
            demandRequestPromises.push(__sendDemandRequest(sessionId, returnParcelSets[i]));
        }

        return demandRequestPromises;
    }

    /* =====================================
     * Constructors
     * ---------------------------------- */

    (function __constructor() {
        RenderService = SpaceCamp.services.RenderService;
        EventsService = SpaceCamp.services.EventsService;
        TimerService = SpaceCamp.services.TimerService;

        __profile = {
            partnerId: 'RubiconExtHtb',
            namespace: 'RubiconExtHtb',
            statsId: 'RUBIX',
            version: '2.1.0',
            targetingType: 'slot',
            enabledAnalytics: {
                requestTime: true
            },
            features: {
                demandExpiry: {
                    enabled: false,
                    value: 0
                },
                rateLimiting: {
                    enabled: false,
                    value: 0
                },
                prefetchDisabled: {
                    enabled: true
                }
            },
            targetingKeys: {
                id: 'ix_rubix_id',
                om: 'ix_rubix_om',
                pm: 'ix_rubix_pm'
            },
            bidUnitInCents: 100, // Input is in cents
            lineItemType: Constants.LineItemTypes.ID_AND_SIZE,
            callbackType: Partner.CallbackTypes.NONE,
            architecture: Partner.Architectures.MRA,
            requestType: Partner.RequestTypes.AJAX
        };

        //? if (DEBUG) {
        var results = ConfigValidators.partnerBaseConfig(configs) || PartnerSpecificValidator(configs);

        if (results) {
            throw Whoopsie('INVALID_CONFIG', results);
        }
        //? }

        /* Rubicon size to sizeId map */
        __sizeToSizeIdMapping = {
            '468x60': 1,
            '728x90': 2,
            '120x600': 8,
            '160x600': 9,
            '300x600': 10,
            '250x250': 14,
            '300x250': 15,
            '336x280': 16,
            '300x100': 19,
            '980x120': 31,
            '250x360': 32,
            '180x500': 33,
            '980x150': 35,
            '468x400': 37,
            '930x180': 38,
            '320x50': 43,
            '300x50': 44,
            '300x300': 48,
            '300x1050': 54,
            '970x90': 55,
            '970x250': 57,
            '1000x90': 58,
            '320x80': 59,
            '320x150': 60,
            '1000x1000': 61,
            '640x480': 65,
            '320x480': 67,
            '1800x1000': 68,
            '320x320': 72,
            '320x160': 73,
            '980x240': 78,
            '980x300': 79,
            '980x400': 80,
            '480x300': 83,
            '970x310': 94,
            '970x210': 96,
            '480x320': 101,
            '768x1024': 102,
            '480x280': 103,
            '320x240': 108,
            '1000x300': 113,
            '320x100': 117,
            '800x250': 125,
            '200x600': 126
        };

        /* Rubicon library url */
        var libUrl = Browser.getProtocol() + '//ads.rubiconproject.com/header/' + configs.accountId + '.js';

        /* Initalize timedOut map and rubiconSlot to Parcel Map */
        __timedOut = {};
        __rubiconSlotToParcel = {};

        /* Initialize partner and load rubicon library */
        __baseClass = Partner(__profile, configs, [libUrl], {
            retriever: __retriever
        });

        /* Save a ref to the rubiconTag library internally */
        __baseClass._pushToCommandQueue(function () {
            __rubiconTag = window.rubicontag;
        });

        /* Apply first party data as soon as the rubiconTag library loads. */
        if (configs.partnerFpd) {
            __baseClass._pushToCommandQueue(function () {
                __applyPageFpd(__transformFirstPartyData(configs.partnerFpd));
            });
        }
    })();

    /* =====================================
     * Public Interface
     * ---------------------------------- */

    var derivedClass = {
        /* Class Information
         * ---------------------------------- */

        //? if (DEBUG) {
        __type__: 'RubiconExtHtb',
        //? }

        //? if (TEST) {
        __baseClass: __baseClass,
        //? }

        /* Data
         * ---------------------------------- */

        //? if (TEST) {
        __profile: __profile,
        __rubiconSlotToParcel: __rubiconSlotToParcel,
        __sizeToSizeIdMapping: __sizeToSizeIdMapping,
        __timedOut: __timedOut,
        //? }

        /* Functions
         * ---------------------------------- */

        setFirstPartyData: setFirstPartyData,

        //? if (TEST) {
        __parseResponse: __parseResponse,
        __createRubiconSlot: __createRubiconSlot,
        __generateTimeoutCallback: __generateTimeoutCallback,
        __mapSizesToRubiconSizeIds: __mapSizesToRubiconSizeIds,
        __render: __render,
        __retriever: __retriever,
        __sendDemandRequest: __sendDemandRequest,
        __transformFirstPartyData: __transformFirstPartyData,
        __transformFpdSubobject: __transformFpdSubobject,
        __applySlotFpd: __applySlotFpd,
        __applyPageFpd: __applyPageFpd
        //? }
    };

    return Classify.derive(__baseClass, derivedClass);
}

////////////////////////////////////////////////////////////////////////////////
// Exports /////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

module.exports = RubiconExtHtb;
