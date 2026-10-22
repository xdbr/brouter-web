/**
 * @jest-environment jsdom
 */

BR = {};
$ = require('jquery');
i18next = require('i18next');
require('leaflet');
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
