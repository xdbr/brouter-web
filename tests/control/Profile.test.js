/**
 * @jest-environment jsdom
 */

BR = {};
$ = require('jquery');
i18next = require('i18next');
require('leaflet');
require('../../js/util/RidingPreferences.js');
require('../../js/control/Profile.js');
require('../../js/format/Gpx.js');

const fs = require('fs');

class CodeMirrorMock {
    static fromTextArea() {
        return new CodeMirrorMock();
    }
    on(event, callback) {
        this.handlers = this.handlers || {};
        this.handlers[event] = callback;
    }
    setValue(value) {
        this.value = value;
        if (this.handlers && this.handlers.change) this.handlers.change(this, { origin: 'setValue' });
    }
    getValue() {
        return this.value;
    }
    isClean() {
        return true;
    }
    markClean() {}
}
CodeMirror = CodeMirrorMock;

BR.Message = jest.fn();

const indexHtmlString = fs.readFileSync('index.html', 'utf8');
const indexHtml = new DOMParser().parseFromString(indexHtmlString, 'text/html');

function toggleSecondaryTab() {
    L.DomUtil.get('profile_params_container').classList.toggle('active');
    profile._activateSecondaryTab();
}

const profileText = `
---context:global   # following code refers to global config
# abc settings
assign isOne   = true  # %isOne% | first var | boolean
assign optTwo  = 2     # %varTwo% | second var | [0=none, 1=opt1, 2=opt2]
assign three   = 3     # %three% | third var | number
`;
const paramsHtml = `
 <input name="isOne" id="customize-profile-isOne" type="checkbox">
 <select name="optTwo" class="form-control form-control-sm" id="customize-profile-optTwo">
  <option value="0">none</option>
  <option value="1">opt1</option>
  <option value="2">opt2</option>
 </select>
 <input name="three" id="customize-profile-three" type="number" class="form-control form-control-sm">
`;

let profile;

beforeEach(() => {
    document.body = indexHtml.body.cloneNode(true);
    localStorage.clear();
    BR.conf = { profiles: ['trekking'], profilesUrl: '' };
    profile = new BR.Profile();
});

describe('getProfileVar', () => {
    test('with comment', () => {
        toggleSecondaryTab();
        profile._setValue(profileText);
        expect(profile.getProfileVar('isOne')).toEqual('true');
        expect(profile.getProfileVar('optTwo')).toEqual('2');
        expect(profile.getProfileVar('three')).toEqual('3');
    });

    test('without comment', () => {
        profile._setValue('   assign foo=1');
        const value = profile.getProfileVar('foo');
        expect(value).toEqual('1');
    });

    test('without "="', () => {
        profile._setValue('assign foo 1');
        const value = profile.getProfileVar('foo');
        expect(value).toEqual('1');
    });

    test('not defined', () => {
        profile._setValue('');
        const value = profile.getProfileVar('foo');
        expect(value).toEqual(undefined);
    });

    test('text undefined', () => {
        profile._setValue(undefined);
        const value = profile.getProfileVar('foo');
        expect(value).toEqual(undefined);
    });

    test('options tab active', () => {
        profile._setValue(profileText);
        document.getElementById('customize-profile-optTwo').value = '1';

        expect(profile.getProfileVar('isOne')).toEqual(true);
        expect(profile.getProfileVar('optTwo')).toEqual('1');
        expect(profile.getProfileVar('three')).toEqual('3');
    });
});

describe('getTransportMode', () => {
    test('bike true', () => {
        const profileText = `
# Bike profile
assign validForBikes = true

# comment`;
        profile._setValue(profileText);
        expect(profile.getTransportMode()).toEqual('bike');
    });

    test('car 1', () => {
        profile._setValue('assign validForCars 1');
        expect(profile.getTransportMode()).toEqual('car');
    });

    test('default foot', () => {
        profile._setValue('');
        expect(profile.getTransportMode()).toEqual('foot');
    });
});

test('_buildParamsForm', () => {
    profile._buildParamsForm(profileText);
    const getValue = (name) => {
        const input = document.getElementById('customize-profile-' + name);
        return input.type === 'checkbox' ? input.checked : input.value;
    };

    expect(getValue('isOne')).toEqual(true);
    expect(getValue('optTwo')).toEqual('2');
    expect(getValue('three')).toEqual('3');
});

test('_buildCustomProfile', () => {
    document.getElementById('profile_params').innerHTML = paramsHtml;
    document.getElementById('customize-profile-isOne').checked = true;
    document.getElementById('customize-profile-optTwo').value = '2';
    document.getElementById('customize-profile-three').value = '3';

    const result = profile._buildCustomProfile(profileText).split('\n');
    expect(result[3]).toMatch(/isOne   = true/);
    expect(result[4]).toMatch(/optTwo  = 2/);
    expect(result[5]).toMatch(/three   = 3/);
});

describe('custom profile persistence', () => {
    test('stores the complete text and a stable selection marker', () => {
        profile.rememberCustomProfile(profileText);
        expect(localStorage.getItem('routingprofile.customText')).toBe(profileText);
        expect(localStorage.getItem('routingprofile')).toBe('Custom');
    });

    test('restores the editor and requests a fresh upload', () => {
        profile.rememberCustomProfile(profileText);
        const update = jest.fn((evt) => evt.callback(null, 'custom_fresh'));
        profile.on('update', update);
        expect(profile.restoreCustomProfile()).toBe(true);
        expect(profile.editor.getValue()).toBe(profileText);
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ profileText, restoring: true }));
        expect(profile.cache.custom_fresh).toBe(profileText);
    });

    test('does not restore when a built-in profile was selected last', () => {
        profile.rememberCustomProfile(profileText);
        localStorage.setItem('routingprofile', 'trekking');
        expect(profile.restoreCustomProfile()).toBe(false);
    });

    test('keeps the text available after an upload failure', () => {
        profile.rememberCustomProfile(profileText);
        profile.on('update', (evt) => evt.callback(new Error('offline')));
        expect(profile.restoreCustomProfile()).toBe(true);
        expect(profile.editor.getValue()).toBe(profileText);
        expect(localStorage.getItem('routingprofile.customText')).toBe(profileText);
    });

    test('handles blocked or full storage without breaking profile editing', () => {
        profile.message.showWarning = jest.fn();
        const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('storage unavailable');
        });
        try {
            expect(() => profile.rememberCustomProfile(profileText)).not.toThrow();
            expect(profile.message.showWarning).toHaveBeenCalled();
        } finally {
            write.mockRestore();
        }
    });

    test('ignores a selection marker without profile text', () => {
        localStorage.setItem('routingprofile', 'Custom');
        expect(profile.restoreCustomProfile()).toBe(false);
    });

    test('clear removes the stored custom profile', () => {
        profile.rememberCustomProfile(profileText);
        profile.clear({ target: { blur() {} }, preventDefault() {} });
        expect(localStorage.getItem('routingprofile.customText')).toBeNull();
        expect(localStorage.getItem('routingprofile')).toBeNull();
    });
});

describe('named profile library', () => {
    const save = (name, text) => {
        profile._setValue(text);
        document.getElementById('saved-profile-name').value = name;
        return profile.saveNamedProfile(false);
    };
    const library = () => JSON.parse(localStorage.getItem('routingprofile.library'));

    beforeEach(() => {
        profile.message.showError = jest.fn();
        profile.message.showWarning = jest.fn();
        profile.on('update', (evt) => {
            profile.rememberCustomProfile(evt.profileText);
            evt.callback(null, 'custom_test');
        });
    });

    test('saves independent named copies and restores the last selected copy', () => {
        expect(save('Gravel', 'assign gravel true')).toBe(true);
        const gravelId = profile.activeSavedId;
        expect(save('Forest', 'assign forest true')).toBe(true);
        const forestId = profile.activeSavedId;
        expect(library().profiles).toHaveLength(2);
        expect(profile.selectSavedProfile(gravelId)).toBe(true);
        expect(profile.editor.getValue()).toBe('assign gravel true');
        expect(library().activeId).toBe(gravelId);
        const restored = new BR.Profile();
        restored.on('update', (evt) => evt.callback(null, 'custom_new'));
        expect(restored.restoreCustomProfile()).toBe(true);
        expect(restored.activeSavedId).toBe(gravelId);
        expect(restored.editor.getValue()).toBe('assign gravel true');
        expect(profile.selectSavedProfile(forestId)).toBe(true);
        expect(profile.editor.getValue()).toBe('assign forest true');
    });

    test('applying edits updates only the selected saved profile', () => {
        save('Gravel', 'assign gravel true');
        const gravelId = profile.activeSavedId;
        save('Forest', 'assign forest true');
        profile.rememberCustomProfile('assign forest false');
        expect(library().profiles.find((item) => item.id === gravelId).text).toBe('assign gravel true');
        expect(library().profiles.find((item) => item.id === profile.activeSavedId).text).toBe('assign forest false');
    });

    test('renames a profile without changing its identity or saved text', () => {
        save('Gravel', 'assign gravel true');
        const id = profile.activeSavedId;
        profile._setValue('unapplied edit');
        document.getElementById('saved-profile-name').value = 'Quiet gravel';
        expect(profile.saveNamedProfile(true)).toBe(true);
        expect(library().profiles).toEqual([{ id, name: 'Quiet gravel', text: 'assign gravel true' }]);
    });

    test('rejects blank, duplicate, and empty profiles', () => {
        expect(save('Gravel', 'assign gravel true')).toBe(true);
        expect(save(' gravel ', 'other text')).toBe(false);
        expect(save('  ', 'other text')).toBe(false);
        expect(save('Empty', '   ')).toBe(false);
        expect(library().profiles).toHaveLength(1);
    });

    test('migrates the previously saved custom text into a named profile', () => {
        localStorage.setItem('routingprofile.customText', profileText);
        const migrated = new BR.Profile();
        expect(migrated.savedProfiles).toHaveLength(1);
        expect(migrated.savedProfiles[0].text).toBe(profileText);
        expect(library().activeId).toBe(migrated.savedProfiles[0].id);
        expect(localStorage.getItem('routingprofile.customText')).toBe(profileText);
    });

    test('selecting a built-in profile detaches edits from the named copy', () => {
        save('Gravel', 'assign gravel true');
        BR.conf = { profilesUrl: '', profiles: ['trekking'] };
        profile.update({ profile: 'trekking' });
        profile.rememberCustomProfile('modified trekking');
        expect(profile.activeSavedId).toBeNull();
        expect(library().profiles[0].text).toBe('assign gravel true');
    });

    test('clearing the editor keeps named profiles available', () => {
        save('Gravel', 'assign gravel true');
        profile.clear({ target: { blur() {} }, preventDefault() {} });
        expect(library().profiles).toHaveLength(1);
        expect(profile.restoreCustomProfile()).toBe(false);
    });

    test('deleting a saved profile resets to the default profile', () => {
        save('Gravel', 'assign gravel true');
        const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
        try {
            profile.deleteSavedProfile();
            expect(library().profiles).toEqual([]);
            expect(profile.activeSavedId).toBeNull();
            expect(profile.editor.getValue()).toBe('');
            expect(localStorage.getItem('routingprofile')).toBe('trekking');
            expect(localStorage.getItem('routingprofile.customText')).toBeNull();
            expect(document.getElementById('saved-profiles').value).toBe('__default__');
        } finally {
            confirm.mockRestore();
        }
    });

    test('a failed write leaves the collection unchanged', () => {
        save('Gravel', 'assign gravel true');
        const before = library();
        const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('full');
        });
        try {
            expect(save('Forest', 'assign forest true')).toBe(false);
            expect(profile.savedProfiles).toEqual(before.profiles);
            expect(profile.message.showWarning).toHaveBeenCalled();
        } finally {
            write.mockRestore();
        }
    });

    test('profile names are rendered as text', () => {
        save('<img src=x onerror=alert(1)>', 'assign gravel true');
        const select = document.getElementById('saved-profiles');
        expect(select.querySelector('img')).toBeNull();
        expect(select.options[2].textContent).toBe('<img src=x onerror=alert(1)>');
    });
});

test('cancelling a profile switch keeps unapplied edits and the selected name', () => {
    profile.message.showWarning = jest.fn();
    profile._setValue('first profile');
    document.getElementById('saved-profile-name').value = 'First';
    profile.saveNamedProfile(false);
    const first = profile.activeSavedId;
    profile._setValue('second profile');
    document.getElementById('saved-profile-name').value = 'Second';
    profile.saveNamedProfile(false);
    const second = profile.activeSavedId;
    profile._setValue('unapplied edit');
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    try {
        const select = document.getElementById('saved-profiles');
        select.value = first;
        select.dispatchEvent(new Event('change'));
        expect(profile.activeSavedId).toBe(second);
        expect(select.value).toBe(second);
        expect(profile.editor.getValue()).toBe('unapplied edit');
    } finally {
        confirm.mockRestore();
    }
});

describe('editing the default profile', () => {
    beforeEach(() => {
        profile.resetToDefault();
        profile._setValue(profileText);
    });

    test.each(['input', 'change'])('a parameter %s event selects Unsaved Profile', (event) => {
        document.getElementById('saved-profile-name').value = 'My draft';
        const checkbox = document.getElementById('customize-profile-isOne');
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event(event, { bubbles: true }));
        expect(document.getElementById('saved-profiles').value).toBe('');
        expect(profile.defaultSelected).toBe(false);
        expect(document.getElementById('saved-profile-name').value).toBe('My draft');
        expect(localStorage.getItem('routingprofile')).toBe('trekking');
    });

    test('typing in the profile editor selects Unsaved Profile', () => {
        profile.editor.handlers.change(profile.editor, { origin: '+input' });
        expect(document.getElementById('saved-profiles').value).toBe('');
        expect(profile.defaultSelected).toBe(false);
    });

    test('loading the original text keeps Default selected', () => {
        expect(document.getElementById('saved-profiles').value).toBe('__default__');
        expect(profile.defaultSelected).toBe(true);
    });
});

describe('rider preference controls', () => {
    const gravel = require('../util/data/ridingProfile.js');

    test('shows five-step choices instead of duplicate preference checkboxes', () => {
        profile._setValue(gravel);
        expect(document.querySelectorAll('.riding-preference')).toHaveLength(4);
        expect(document.querySelectorAll('input[name="rider_pref_forest"]')).toHaveLength(5);
        expect(document.querySelector('input[name="prefer_forests"]')).toBeNull();
        expect(document.querySelector('[data-profile-section="rider"] input[name="bikerPower"]')).not.toBeNull();
    });

    test('unchanged ratings do not rewrite a profile or mark it as edited', () => {
        profile._setValue(gravel);
        expect(profile._currentText()).toBe(gravel);
    });

    test('rating changes mark defaults as edited and generate weighted rules', () => {
        profile.resetToDefault();
        profile._setValue(gravel);
        const radio = document.querySelector('input[name="rider_pref_forest"][value="4"]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        expect(profile.defaultSelected).toBe(false);
        expect(radio.closest('label').classList.contains('active')).toBe(true);
        const generated = profile._currentText();
        expect(BR.RidingPreferences.ratings(generated).forest).toBe(4);
        expect(generated).toContain('assign rider_forest_strength = 0.75');
    });

    test('ratings survive named saving and restoring, including full-editor round trips', () => {
        profile._setValue(gravel);
        document.querySelector('input[name="rider_pref_quiet"][value="3"]').checked = true;
        document.getElementById('saved-profile-name').value = 'Quiet gravel';
        profile.on('update', (evt) => {
            profile.rememberCustomProfile(evt.profileText);
            evt.callback(null, 'custom_rating');
        });
        profile.saveNamedProfile(false);
        const restored = new BR.Profile();
        restored.on('update', (evt) => evt.callback(null, 'custom_restored'));
        expect(restored.restoreCustomProfile()).toBe(true);
        expect(document.querySelector('input[name="rider_pref_quiet"]:checked').value).toBe('3');
        toggleSecondaryTab();
        expect(BR.RidingPreferences.ratings(profile.editor.getValue()).quiet).toBe(3);
    });
});

test('profile settings stay visible in sections when the form is rebuilt', () => {
    const gravel = require('../util/data/ridingProfile.js');
    const extra = `
assign totalMass = 90 # %totalMass% | Total weight | number
assign C_r = 0.005 # %C_r% | Rolling resistance | number
assign uphillcost = 80 # %uphillcost% | Climb cost | number
assign turnInstructionMode = 1 # %turnInstructionMode% | Navigation | [0=none, 1=auto]
assign processUnusedTags = false # %processUnusedTags% | Debug | boolean
assign allow_ferries = true # %allow_ferries% | Ferries | boolean
assign custom_value = 7 # %custom_value% | Custom | number
`;
    profile._setValue(gravel.replace('---context:way', extra + '\n---context:way'));
    document.querySelector('input[name="bikerPower"]').value = '175';
    profile._setValue(profile._currentText());
    expect(document.querySelectorAll('#profile_params details')).toHaveLength(7);
    expect(document.querySelectorAll('#profile_params details:not([open])')).toHaveLength(0);
    const contains = (section, name) => document.querySelector(`[data-profile-section="${section}"] [name="${name}"]`);
    expect(contains('rider', 'bikerPower').value).toBe('175');
    expect(contains('rider', 'totalMass')).not.toBeNull();
    expect(contains('bike', 'C_r')).not.toBeNull();
    expect(contains('elevation', 'uphillcost')).not.toBeNull();
    expect(contains('navigation', 'turnInstructionMode')).not.toBeNull();
    expect(contains('advanced', 'processUnusedTags')).not.toBeNull();
    expect(contains('preferences', 'allow_ferries')).not.toBeNull();
    expect(contains('other', 'custom_value')).not.toBeNull();
    expect(document.querySelectorAll('[data-profile-section="rider"]')).toHaveLength(1);
});

test('section choices survive form rebuilds and switching editor tabs', () => {
    profile._setValue(require('../util/data/ridingProfile.js'));
    const riderSection = () => document.querySelector('[data-profile-section="rider"] details');
    const preferences = () => document.querySelector('[data-profile-section="preferences"] details');
    riderSection().open = false;
    profile._setValue(profile._currentText());
    expect(riderSection().open).toBe(false);
    expect(preferences().open).toBe(true);
    expect(preferences().querySelector('summary h2')).not.toBeNull();
    toggleSecondaryTab();
    toggleSecondaryTab();
    expect(riderSection().open).toBe(false);
    expect(preferences().open).toBe(true);
});

describe('plain-language boolean switches', () => {
    const switchProfile = `
---context:global
assign validForBikes = true
assign allow_ferries = true # %allow_ferries% | Allow ferries | boolean
assign assume_wet_conditions = false # %assume_wet_conditions% | Wet | boolean
---context:way
assign costfactor 1
`;

    beforeEach(() => {
        i18next.init({
            lng: 'en',
            initImmediate: false,
            resources: { en: { translation: require('../../locales/en.json') } },
        });
        profile._setValue(switchProfile);
    });

    test('renders labeled switches with associated plain-language descriptions', () => {
        const input = document.querySelector('input[name="assume_wet_conditions"]');
        expect(input.getAttribute('role')).toBe('switch');
        expect(input.closest('.custom-switch')).not.toBeNull();
        expect(input.labels[0].textContent).toBe('Plan for wet conditions');
        expect(document.getElementById(input.getAttribute('aria-describedby')).textContent).toContain('muddy');
        expect(input.id).toBe('customize-profile-assume_wet_conditions');
        expect(input.checked).toBe(false);
    });

    test('clicking a switch label still serializes the original boolean variable', () => {
        const input = document.querySelector('input[name="allow_ferries"]');
        profile.defaultSelected = true;
        input.labels[0].click();
        expect(input.checked).toBe(false);
        expect(profile.defaultSelected).toBe(false);
        expect(profile._currentText()).toContain('assign allow_ferries = false');
        expect(profile._getFormValues().allow_ferries).toBe(false);
        expect(profile._getFormValues()).not.toHaveProperty('Allow ferries');
    });
});

describe('numeric profile controls', () => {
    const numericProfile = `---context:global
assign totalMass = 90 # %totalMass% | Weight | number
assign maxSpeed = 35 # %maxSpeed% | Speed | number
assign bikerPower = 150 # %bikerPower% | Power | number
assign C_r = 0.005 # %C_r% | Rolling resistance | number
assign uphillcutoff = 1.5 # %uphillcutoff% | Gradient | number
assign customOffset = -2e-3 # %customOffset% | Custom offset | number
---context:way
assign costfactor 1
`;
    const field = (name) => document.querySelector('#profile_params input[name="' + name + '"]');
    const change = (name, value) => {
        const input = field(name);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input;
    };
    const reset = (name) => field(name).closest('.profile-number').querySelector('.profile-number-reset');

    beforeEach(() => {
        i18next.init({
            lng: 'en',
            initImmediate: false,
            resources: { en: { translation: require('../../locales/en.json') } },
        });
        profile._setValue(numericProfile);
    });

    test('shows units beside inputs and keeps decimal and custom values intact', () => {
        expect(field('totalMass').labels[0].textContent).toBe('Total weight');
        expect(document.getElementById('profile-unit-totalMass').textContent).toBe('kg');
        expect(document.getElementById('profile-default-maxSpeed').textContent).toBe('Starting value: 35 km/h');
        expect(field('totalMass').getAttribute('aria-describedby')).toContain('profile-unit-totalMass');
        expect(field('C_r').value).toBe('0.005');
        expect(field('customOffset').value).toBe('-0.002');
        expect(field('customOffset').hasAttribute('min')).toBe(false);
        expect(profile._currentText()).toBe(numericProfile);
        expect(profile._currentText()).not.toContain('brouter-web numeric defaults');
    });

    test('increments use meaningful steps without limiting manually entered precision', () => {
        field('bikerPower').closest('.profile-number').querySelectorAll('.profile-number-step')[1].click();
        expect(field('bikerPower').value).toBe('155');
        field('C_r').closest('.profile-number').querySelectorAll('.profile-number-step')[0].click();
        expect(field('C_r').value).toBe('0.004');
        field('uphillcutoff').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        expect(field('uphillcutoff').value).toBe('2');
        const precise = change('bikerPower', '153.25');
        expect(precise.checkValidity()).toBe(true);
        expect(profile._validateParams()).toBe(true);
        expect(profile._currentText()).toContain('assign bikerPower = 153.25');
    });

    test('reset restores the starting value and marks Default as edited', () => {
        profile.defaultSelected = true;
        change('totalMass', '94.5');
        expect(profile.defaultSelected).toBe(false);
        expect(reset('totalMass').disabled).toBe(false);
        reset('totalMass').click();
        expect(field('totalMass').value).toBe('90');
        expect(reset('totalMass').disabled).toBe(true);
        expect(document.activeElement).toBe(field('totalMass'));
        expect(profile._currentText()).toBe(numericProfile);
    });

    test.each([
        ['maxSpeed', '0', 'greater than 0'],
        ['totalMass', '-1', 'greater than 0'],
        ['bikerPower', '', 'valid number'],
        ['C_r', '-0.001', '0 or more'],
    ])('invalid %s blocks applying, named saving, and leaving the form', (name, value, message) => {
        const input = change(name, value);
        const details = input.closest('details');
        details.open = false;
        expect(document.getElementById('profile-error-' + name).textContent).toContain(message);
        expect(input.getAttribute('aria-invalid')).toBe('true');
        const update = jest.fn();
        profile.on('update', update);
        profile._save();
        expect(details.open).toBe(true);
        expect(update).not.toHaveBeenCalled();
        document.getElementById('saved-profile-name').value = 'Invalid';
        expect(profile.saveNamedProfile(false)).toBe(false);
        expect(localStorage.getItem(profile.libraryKey)).toBeNull();
        const hide = $.Event('hide.bs.tab');
        $('#profileEditorTabs a[href="#profile_params_container"]').trigger(hide);
        expect(hide.isDefaultPrevented()).toBe(true);
        expect(document.activeElement).toBe(input);
        reset(name).click();
        expect(input.getAttribute('aria-invalid')).toBe('false');
        expect(document.getElementById('profile-error-' + name).textContent).toBe('');
        expect(profile._validateParams()).toBe(true);
    });

    test('does not impose arbitrary maximums or restrict unfamiliar signed settings', () => {
        change('maxSpeed', '999');
        change('customOffset', '-0.000125');
        expect(profile._validateParams()).toBe(true);
        const generated = profile._currentText();
        profile._setValue(generated);
        expect(field('maxSpeed').value).toBe('999');
        expect(field('customOffset').value).toBe('-0.000125');
        expect(profile._currentText()).toBe(generated);
    });

    test('starting values survive Apply, named save, reload, and repeated edits', () => {
        profile.on('update', (evt) => {
            profile.rememberCustomProfile(evt.profileText);
            evt.callback(null, 'custom_numbers', evt.profileText);
        });
        change('totalMass', '95');
        profile._save();
        expect(field('totalMass').value).toBe('95');
        expect(document.getElementById('profile-default-totalMass').textContent).toContain('90 kg');
        change('totalMass', '100');
        document.getElementById('saved-profile-name').value = 'My bike';
        expect(profile.saveNamedProfile(false)).toBe(true);
        const restored = new BR.Profile();
        restored.on('update', (evt) => evt.callback(null, 'custom_restored'));
        expect(restored.restoreCustomProfile()).toBe(true);
        expect(field('totalMass').value).toBe('100');
        reset('totalMass').click();
        expect(field('totalMass').value).toBe('90');
        expect(restored._currentText().match(/# brouter-web numeric defaults:/g)).toHaveLength(1);
    });

    test('full-editor round trips preserve starting values', () => {
        change('bikerPower', '175');
        toggleSecondaryTab();
        expect(profile.editor.getValue()).toContain('assign bikerPower = 175');
        toggleSecondaryTab();
        expect(field('bikerPower').value).toBe('175');
        reset('bikerPower').click();
        expect(field('bikerPower').value).toBe('150');
    });

    test.each(['broken json', 'null', '[]', '{"totalMass":"wrong"}'])(
        'falls back to the loaded value for unusable starting-value metadata: %s',
        (metadata) => {
            profile._setValue('# brouter-web numeric defaults: ' + metadata + '\n' + numericProfile);
            change('totalMass', '100');
            reset('totalMass').click();
            expect(field('totalMass').value).toBe('90');
        }
    );
});

test('navigation format help explains the current selection without changing its stored value', () => {
    i18next.init({
        lng: 'en',
        initImmediate: false,
        resources: { en: { translation: require('../../locales/en.json') } },
    });
    profile._setValue(`---context:global
assign turnInstructionMode = 1 # %turnInstructionMode% | Navigation | [0=none, 1=auto, 2=locus, 3=osmand, 4=comments, 5=gpsies, 6=orux, 7=locus-old, 9=custom]
`);
    const select = document.querySelector('select[name="turnInstructionMode"]');
    const help = document.getElementById('profile-option-help-turnInstructionMode');
    expect(help.textContent).toContain('does not include turn instructions with Automatic');
    expect(select.getAttribute('aria-describedby')).toContain(help.id);
    for (const value of ['0', '2', '3', '4', '5', '6', '7']) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(help.hidden).toBe(false);
        expect(help.textContent).toBe(i18next.t('profileParameterOptionDescriptions.turnInstructionMode.' + value));
        expect(profile._currentText()).toContain('assign turnInstructionMode = ' + value);
    }
    select.value = '9';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(help.hidden).toBe(true);
    expect(help.textContent).toBe('');
    expect(select.selectedOptions[0].textContent).toBe('custom');
    expect(profile._currentText()).toContain('assign turnInstructionMode = 9');
});
