/**
 * @jest-environment jsdom
 */

BR = {};
$ = require('jquery');
i18next = require('i18next');
require('bootstrap');
require('bootstrap-select');
require('leaflet');

require('../../config.template.js');
require('../../js/Util.js');
require('../../js/router/BRouter.js');
require('../../js/control/RoutingOptions.js');

const fs = require('fs');
const indexHtmlString = fs.readFileSync('index.html', 'utf8');
const indexHtml = new DOMParser().parseFromString(indexHtmlString, 'text/html');

let defaultProfile;

beforeEach(() => {
    document.body = indexHtml.body.cloneNode(true);
    location.hash = '';
    localStorage.clear();
    // as used in BRouter.getUrlParams
    defaultProfile = BR.conf.profiles[0];
});

describe('Profile selection', () => {
    test('sets default profile (trekking) when no hash and no localStorage entry', () => {
        let routingOptions = new BR.RoutingOptions();
        routingOptions.setOptions({});
        const profile = routingOptions.getOptions().profile;
        expect(profile).toEqual(defaultProfile);
    });

    // defaults are not set in hash, see BRouter.getUrlParams
    test('sets default profile (trekking) when hash without `profile` param regardless of localStorage', () => {
        location.hash = '#map=5/50.986/9.822/standard';
        localStorage.routingprofile = 'shortest';

        let routingOptions = new BR.RoutingOptions();
        routingOptions.setOptions({});
        const profile = routingOptions.getOptions().profile;
        expect(profile).toEqual(defaultProfile);
    });

    test('sets profile from hash', () => {
        location.hash = '#map=5/50.986/9.822/standard&profile=fastbike';
        localStorage.routingprofile = 'shortest';

        let routingOptions = new BR.RoutingOptions();
        routingOptions.setOptions({ profile: 'fastbike' });
        const profile = routingOptions.getOptions().profile;
        expect(profile).toEqual('fastbike');
    });

    test('sets profile from localStorage when no hash', () => {
        localStorage.routingprofile = 'shortest';

        let routingOptions = new BR.RoutingOptions();
        routingOptions.setOptions({});
        const profile = routingOptions.getOptions().profile;
        expect(profile).toEqual('shortest');
    });
});

describe('remembering custom selections', () => {
    test('remembers the local custom profile rather than its temporary server ID', () => {
        const routingOptions = new BR.RoutingOptions();
        localStorage.setItem('routingprofile.customText', 'assign validForBikes true');
        routingOptions.rememberProfile('custom_temporary');
        expect(localStorage.getItem('routingprofile')).toBe('Custom');
        routingOptions.rememberProfile('shortest');
        expect(localStorage.getItem('routingprofile')).toBe('shortest');
        expect(localStorage.getItem('routingprofile.customText')).not.toBeNull();
    });

    test('does not remember a custom ID without saved text', () => {
        const routingOptions = new BR.RoutingOptions();
        routingOptions.rememberProfile('trekking');
        routingOptions.rememberProfile('custom_temporary');
        expect(localStorage.getItem('routingprofile')).toBe('trekking');
    });
});

test('programmatic startup selection does not overwrite the saved custom marker', () => {
    localStorage.setItem('routingprofile.customText', 'assign validForBikes true');
    localStorage.setItem('routingprofile', 'Custom');
    location.hash = '#map=12/48.0305/11.6027/standard&lonlats=11.57,48.12;11.56,48.04';
    $('.selectpicker').selectpicker();
    const routingOptions = new BR.RoutingOptions();
    routingOptions.setOptions({});
    expect(localStorage.getItem('routingprofile')).toBe('Custom');
});

test('a user selection still replaces the saved custom marker', () => {
    localStorage.setItem('routingprofile.customText', 'assign validForBikes true');
    localStorage.setItem('routingprofile', 'Custom');
    $('.selectpicker').selectpicker();
    const routingOptions = new BR.RoutingOptions();
    const select = document.getElementById('profile-alternative');
    const index = Array.from(select.options).findIndex((option) => option.value === 'shortest');
    routingOptions.setOptions({ profile: 'shortest' });
    $(select).trigger('changed.bs.select', [index, true, null]);
    expect(localStorage.getItem('routingprofile')).toBe('shortest');
});
