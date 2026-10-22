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

describe('separate route alternative dropdown', () => {
    test('changing the alternative keeps the profile and its remembered selection', () => {
        $('.selectpicker').selectpicker();
        const options = new BR.RoutingOptions();
        options.setOptions({ profile: 'shortest' });
        options.rememberProfile('shortest');
        const update = jest.fn();
        options.on('update', update);
        const alternative = document.getElementById('route-alternative');
        alternative.value = '2';
        $(alternative).trigger('changed.bs.select', [2, true, '0']);
        expect(options.getOptions()).toEqual({ profile: 'shortest', alternative: '2' });
        expect(localStorage.getItem('routingprofile')).toBe('shortest');
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({
                options: { profile: 'shortest', alternative: '2' },
                alternativeOnly: true,
            })
        );
    });

    test('switching saved profiles preserves the alternative', () => {
        const options = new BR.RoutingOptions();
        options.setOptions({ alternative: '3' });
        options.setSavedProfiles([{ id: 'gravel', name: 'Gravel' }], 'gravel');
        options.setCustomProfile('custom_gravel', true, 'gravel');
        expect(options.getOptions()).toEqual({ profile: 'custom_gravel', alternative: '3' });
        options.restoreSelection('trekking');
        expect(options.getOptions()).toEqual({ profile: 'trekking', alternative: '3' });
    });

    test('restoring URL options updates both dropdowns without intermediate reroutes', () => {
        $('.selectpicker').selectpicker();
        const options = new BR.RoutingOptions();
        const update = jest.fn();
        options.on('update', update);
        options.setOptions({ profile: 'fastbike', alternative: '2' });
        expect(options.getOptions()).toEqual({ profile: 'fastbike', alternative: '2' });
        expect(update).not.toHaveBeenCalled();
        options.setOptions({ alternative: 0 });
        expect(options.getOptions()).toEqual({ profile: 'fastbike', alternative: '0' });
    });
});

describe('dropdown shortcuts', () => {
    test.each([
        [false, '#profile-alternative', '#route-alternative'],
        [true, '#route-alternative', '#profile-alternative'],
    ])('G with shift=%s opens only its assigned dropdown', (shiftKey, target, other) => {
        $('.selectpicker').selectpicker();
        const options = new BR.RoutingOptions();
        const targetToggle = jest.spyOn($(target).data('selectpicker'), 'toggle').mockImplementation(() => {});
        const otherToggle = jest.spyOn($(other).data('selectpicker'), 'toggle').mockImplementation(() => {});
        const event = { keyCode: 71, shiftKey, target: document.body, preventDefault: jest.fn() };
        options._keydownListener(event);
        expect(targetToggle).toHaveBeenCalledWith(event);
        expect(otherToggle).not.toHaveBeenCalled();
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    test('shortcuts do not open dropdowns while typing or using browser modifiers', () => {
        $('.selectpicker').selectpicker();
        const options = new BR.RoutingOptions();
        const profileToggle = jest
            .spyOn($('#profile-alternative').data('selectpicker'), 'toggle')
            .mockImplementation(() => {});
        const alternativeToggle = jest
            .spyOn($('#route-alternative').data('selectpicker'), 'toggle')
            .mockImplementation(() => {});
        const input = document.getElementById('saved-profile-name');
        input.focus();
        options._keydownListener({ keyCode: 71, shiftKey: true });
        input.blur();
        options._keydownListener({ keyCode: 71, ctrlKey: true });
        options._keydownListener({ keyCode: 71, metaKey: true });
        expect(profileToggle).not.toHaveBeenCalled();
        expect(alternativeToggle).not.toHaveBeenCalled();
    });
});

test.each(['#profile-alternative', '#route-alternative'])(
    'Escape closes %s and allows opening the other dropdown',
    (selector) => {
        $('.selectpicker').selectpicker();
        const options = new BR.RoutingOptions();
        const picker = $(selector).data('selectpicker');
        const before = options.getOptions();
        picker.$newElement.addClass('show');
        picker.$menu.addClass('show');
        picker.$button[0].focus();
        const event = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
        picker.$button[0].dispatchEvent(event);
        expect(picker.$newElement.hasClass('show')).toBe(false);
        expect(document.activeElement).toBe(document.getElementById('map'));
        expect(options.getOptions()).toEqual(before);
        const other = selector === '#profile-alternative' ? '#route-alternative' : '#profile-alternative';
        const toggle = jest.spyOn($(other).data('selectpicker'), 'toggle').mockImplementation(() => {});
        options._keydownListener({ keyCode: 71, shiftKey: other === '#route-alternative', preventDefault: jest.fn() });
        expect(toggle).toHaveBeenCalledTimes(1);
    }
);

test.each([
    ['#profile-alternative', 'shortest'],
    ['#route-alternative', '2'],
])('Enter confirms a selection in %s and returns focus to the map', async (selector, value) => {
    $('.selectpicker').selectpicker();
    const options = new BR.RoutingOptions();
    options.getOptions();
    const picker = $(selector).data('selectpicker');
    const index = Array.from($(selector)[0].options).findIndex((option) => option.value === value);
    const position = picker.selectpicker.main.data.findIndex((item) => item.option === $(selector)[0].options[index]);
    const item = picker.selectpicker.main.elements[position];
    // Highlight an item as keyboard navigation does, without requiring layout.
    picker.$menuInner.find('li').removeClass('active');
    $(item).addClass('active');
    picker.$newElement.addClass('show');
    picker.$menu.addClass('show');
    item.firstChild.focus();
    item.firstChild.dispatchEvent(
        new KeyboardEvent('keydown', {
            key: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
        })
    );
    // Leave focus untouched through the event's microtask checkpoints so the
    // browser can finish invoking delegated keyboard handlers.
    expect($(selector).val()).toBe(value);
    await Promise.resolve();
    expect(document.activeElement).not.toBe(document.getElementById('map'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect($(selector).val()).toBe(value);
    expect(picker.$newElement.hasClass('show')).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('map'));
});
