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

test('resetting defaults clears the custom selection and alternative', () => {
    const routingOptions = new BR.RoutingOptions();
    routingOptions.setCustomProfile('custom_test', true);
    document.querySelector('#alternative option[value="2"]').selected = true;
    const update = jest.fn();
    routingOptions.on('update', update);
    routingOptions.resetToDefault();
    expect(routingOptions.getOptions()).toEqual({ profile: BR.conf.profiles[0], alternative: '0' });
    expect(routingOptions.getCustomProfile()).toBeNull();
    expect(localStorage.getItem('routingprofile')).toBe(BR.conf.profiles[0]);
    expect(update).toHaveBeenCalledTimes(1);
});

describe('saved profiles in the navbar', () => {
    const profiles = [
        { id: 'gravel', name: 'Quiet gravel' },
        { id: 'forest', name: 'Forest rides' },
    ];

    test('lists saved profiles and maps their selection to server IDs', () => {
        const options = new BR.RoutingOptions();
        options.setSavedProfiles(profiles, 'gravel');
        options.setCustomProfile('custom_gravel', true, 'gravel');
        expect(document.querySelector('#profile option:checked').textContent).toBe('Quiet gravel');
        expect(options.getOptions().profile).toBe('custom_gravel');
        options.setSavedProfiles(profiles, 'forest');
        options.setCustomProfile('custom_forest', true, 'forest');
        expect(options.getOptions().profile).toBe('custom_forest');
        options.setSavedProfiles(profiles, 'gravel');
        expect(options.getOptions().profile).toBe('custom_gravel');
    });

    test('a user selection requests the saved profile without routing with a local ID', () => {
        $('.selectpicker').selectpicker();
        const options = new BR.RoutingOptions();
        options.setSavedProfiles(profiles, null);
        const select = document.getElementById('profile-alternative');
        const index = Array.from(select.options).findIndex((option) => option.dataset.savedId === 'forest');
        const saved = jest.fn();
        const update = jest.fn();
        options.on('saved-profile', saved);
        options.on('update', update);
        $(select).trigger('changed.bs.select', [index, true, ['trekking', '0']]);
        expect(saved).toHaveBeenCalledWith(expect.objectContaining({ id: 'forest', previousValue: ['trekking', '0'] }));
        expect(update).not.toHaveBeenCalled();
        expect(localStorage.getItem('routingprofile')).toBeNull();
    });

    test('renaming and deletion update the list while keeping the alternative', () => {
        const options = new BR.RoutingOptions();
        options.setSavedProfiles(profiles, 'gravel');
        options.setCustomProfile('custom_gravel', true, 'gravel');
        options.setSavedProfiles([{ id: 'gravel', name: 'Renamed gravel' }], 'gravel');
        expect(document.querySelector('#profile option:checked').textContent).toBe('Renamed gravel');
        expect(options.getOptions()).toEqual({ profile: 'custom_gravel', alternative: '0' });
        expect(document.querySelector('[data-saved-id="forest"]')).toBeNull();
        options.setSavedProfiles([], null);
        expect(document.querySelectorAll('[data-saved-id]')).toHaveLength(0);
        options.resetToDefault();
        expect(options.getOptions().profile).toBe('trekking');
    });

    test('cancelling a switch restores the previous navbar selection', () => {
        const options = new BR.RoutingOptions();
        options.setSavedProfiles(profiles, 'forest');
        options.restoreSelection(['trekking', '0']);
        expect(options.getOptions()).toEqual({ profile: 'trekking', alternative: '0' });
    });
});
